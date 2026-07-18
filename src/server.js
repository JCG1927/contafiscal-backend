const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const twilio = require('twilio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ─── Webhook Twilio ───────────────────────────────────────────────────────────
app.post('/webhook-twilio', async (req, res) => {
  res.sendStatus(200);
  try {
    const from     = req.body.From;
    const numMedia = parseInt(req.body.NumMedia || '0');

    console.log(`Mensaje de ${from} | media: ${numMedia}`);

    if (numMedia === 0) {
      await sendTwilio(from,
        '📋 Envía una *foto* de tu factura para registrarla.\n\n' +
        'Acepto facturas *con o sin* comprobante fiscal (NCF).'
      );
      return;
    }

    await sendTwilio(from, '⏳ Analizando tu factura... un momento.');

    // Descargar imagen desde Twilio
    const mediaUrl    = req.body.MediaUrl0;
    const imageBuffer = await downloadTwilioMedia(mediaUrl);

    // Extraer datos con Gemini IA
    const jsonTexto = await ocr(imageBuffer);
    console.log('Gemini extrajo:', jsonTexto.substring(0, 300));

    // Parsear JSON de Gemini
    const factura = parsearGemini(jsonTexto);
    factura.telefono_emisor = from.replace('whatsapp:', '');
    factura.fecha_registro  = new Date().toISOString();
    factura.fuente          = 'whatsapp';
    factura.categoria       = factura.ncf ? 'fiscal' : 'gasto';
    factura.estado          = 'verified';

    const { data, error } = await supabase
      .from('facturas')
      .insert([factura])
      .select()
      .single();

    if (error) throw error;

    const respuesta = factura.categoria === 'fiscal'
      ? respuestaFiscal(factura)
      : respuestaGasto(factura);

    await sendTwilio(from, respuesta);
    console.log(`✅ Factura guardada [${factura.categoria}] id:${data.id}`);

  } catch (err) {
    console.error('❌ Error:', err.message);
  }
});

// ─── Descargar imagen de Twilio ───────────────────────────────────────────────
async function downloadTwilioMedia(mediaUrl) {
  const res = await axios.get(mediaUrl, {
    auth: {
      username: process.env.TWILIO_ACCOUNT_SID,
      password: process.env.TWILIO_AUTH_TOKEN
    },
    responseType: 'arraybuffer'
  });
  return Buffer.from(res.data);
}

// ─── Extraer datos de factura con Gemini IA ──────────────────────────────────
async function ocr(imageBuffer) {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const imagePart = {
    inlineData: {
      data: imageBuffer.toString('base64'),
      mimeType: 'image/jpeg'
    }
  };

  const prompt = `Eres un experto en facturas dominicanas. Analiza esta imagen de factura y extrae los siguientes datos en formato JSON exacto:

{
  "ncf": "número de comprobante fiscal (formato B01XXXXXXXXX, B02XXXXXXXXX, B14XXXXXXXXX, E31XXXXXXXXX, etc.) o null si no tiene",
  "rnc": "RNC o cédula del emisor (formato X-XX-XXXXX-X o 9 dígitos) o null si no tiene",
  "razon_social": "nombre de la empresa o negocio emisor",
  "fecha": "fecha en formato YYYY-MM-DD o null si no se ve",
  "monto": "monto total como número sin símbolos o null si no se ve",
  "itbis": "monto del ITBIS como número sin símbolos o null si no se ve"
}

Responde SOLO con el JSON, sin texto adicional ni markdown.`;

  const result = await model.generateContent([prompt, imagePart]);
  const text = result.response.text().trim();
  console.log('Gemini respuesta:', text);
  return text;
}

// ─── Parsear respuesta JSON de Gemini ────────────────────────────────────────
function parsearGemini(jsonTexto) {
  try {
    const clean = jsonTexto.replace(/```json|```/g, '').trim();
    const data = JSON.parse(clean);
    return {
      ncf:          data.ncf || null,
      tipo_ncf:     data.ncf ? tipoNcf(data.ncf) : null,
      rnc:          data.rnc || null,
      razon_social: data.razon_social || null,
      fecha:        data.fecha || null,
      monto:        data.monto ? parseFloat(String(data.monto).replace(/,/g,'')) : null,
      itbis:        data.itbis ? parseFloat(String(data.itbis).replace(/,/g,'')) : null,
      texto_ocr:    jsonTexto.substring(0, 600)
    };
  } catch(e) {
    console.error('Error parseando JSON de Gemini:', e.message);
    return { ncf: null, tipo_ncf: null, rnc: null, razon_social: 'No detectado', fecha: null, monto: null, itbis: null, texto_ocr: jsonTexto };
  }
}

function tipoNcf(ncf) {
  const cod = ncf.substring(0, 3).toUpperCase();
  const mapa = { B01:'Crédito Fiscal', B02:'Consumidor Final', B14:'Gubernamental', B15:'Regímenes Especiales', E31:'Electrónico CF' };
  return mapa[cod] || cod;
}

// ─── Parser de facturas dominicanas (fallback) ────────────────────────────────
function parsear(texto) {
  const lineas = texto.split('\n').map(l => l.trim()).filter(Boolean);

  // NCF
  const ncfMatch = texto.match(/[BE]\d{2}\d{8,11}/i);
  const ncf      = ncfMatch ? ncfMatch[0].toUpperCase() : null;

  let tipo_ncf = null;
  if (ncf) {
    const cod  = ncf.substring(0, 3).toUpperCase();
    const mapa = { B01:'Crédito Fiscal', B02:'Consumidor Final', B14:'Gubernamental', B15:'Regímenes Especiales', E31:'Electrónico CF' };
    tipo_ncf   = mapa[cod] || cod;
  }

  // RNC
  const rncMatch = texto.match(/\d{1}-\d{2}-\d{5}-\d|\b\d{9}\b/);
  const rnc      = rncMatch ? rncMatch[0] : null;

  // Monto total
  let monto = null;
  const montoPatrones = [
    /total\s*r?d?\$?\s*([\d,\.]+)/i,
    /total\s*rds\s*([\d,\.]+)/i,
    /importe\s*r?d?\$?\s*([\d,\.]+)/i,
    /monto\s*r?d?\$?\s*([\d,\.]+)/i,
  ];
  for (const p of montoPatrones) {
    const m = texto.match(p);
    if (m) { monto = parseFloat(m[1].replace(/,/g, '')); break; }
  }

  // ITBIS
  let itbis = null;
  const itbisMatch = texto.match(/itbis[\s:$RD]*([0-9,\.]+)/i);
  if (itbisMatch) {
    itbis = parseFloat(itbisMatch[1].replace(/,/g, ''));
  } else if (monto && ncf) {
    itbis = Math.round(monto * 0.18 * 100) / 100;
  }

  // Fecha
  let fecha = null;
  const f1 = texto.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  const f2 = texto.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
  if (f2) {
    fecha = f2[0];
  } else if (f1) {
    const [, d, m, y] = f1;
    fecha = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // Razón social
  const ignorar = /RNC|NCF|ITBIS|TOTAL|TEL|FAX|CORREO|EMAIL|WWW|HTTP|FECHA|FACT|HORA|DIRECCI|ZONA|C\/|NO\.|NUM/i;
  let razon_social = null;
  for (const linea of lineas.slice(0, 12)) {
    if (linea.length > 4 && linea.length < 60 && !/^\d/.test(linea) && !ignorar.test(linea)) {
      razon_social = linea;
      break;
    }
  }

  return { ncf, tipo_ncf, rnc, razon_social, fecha, monto, itbis, texto_ocr: texto.substring(0, 600) };
}

// ─── Respuestas WhatsApp ──────────────────────────────────────────────────────
function respuestaFiscal(f) {
  const lines = ['✅ *Comprobante fiscal registrado*\n'];
  if (f.ncf)          lines.push(`🔢 NCF: ${f.ncf}`);
  if (f.tipo_ncf)     lines.push(`📄 Tipo: ${f.tipo_ncf}`);
  if (f.rnc)          lines.push(`🏢 RNC: ${f.rnc}`);
  if (f.razon_social) lines.push(`🏷️ Empresa: ${f.razon_social}`);
  if (f.fecha)        lines.push(`📅 Fecha: ${f.fecha}`);
  if (f.monto)        lines.push(`💰 Monto: RD$ ${f.monto.toLocaleString()}`);
  if (f.itbis)        lines.push(`🧾 ITBIS: RD$ ${f.itbis.toLocaleString()}`);
  lines.push(`\n📊 Ver panel: ${process.env.APP_URL}`);
  return lines.join('\n');
}

function respuestaGasto(f) {
  const lines = ['🧾 *Gasto registrado*\n', '⚠️ Sin NCF — registrado como gasto general.\n'];
  if (f.razon_social) lines.push(`🏷️ Empresa: ${f.razon_social}`);
  if (f.fecha)        lines.push(`📅 Fecha: ${f.fecha}`);
  if (f.monto)        lines.push(`💰 Monto: RD$ ${(f.monto||0).toLocaleString()}`);
  lines.push(`\n📊 Ver panel: ${process.env.APP_URL}`);
  return lines.join('\n');
}

// ─── Enviar mensaje Twilio ────────────────────────────────────────────────────
async function sendTwilio(to, body) {
  await twilioClient.messages.create({
    from: `whatsapp:${process.env.TWILIO_PHONE}`,
    to,
    body
  });
}

// ─── API REST ─────────────────────────────────────────────────────────────────
app.get('/api/facturas', async (req, res) => {
  const { categoria, tipo, estado, desde, hasta, q } = req.query;
  let query = supabase.from('facturas').select('*').order('created_at', { ascending: false });
  if (categoria) query = query.eq('categoria', categoria);
  if (tipo)      query = query.eq('tipo_ncf', tipo);
  if (estado)    query = query.eq('estado', estado);
  if (desde)     query = query.gte('fecha', desde);
  if (hasta)     query = query.lte('fecha', hasta);
  if (q)         query = query.or(`rnc.ilike.%${q}%,razon_social.ilike.%${q}%,ncf.ilike.%${q}%`);
  const { data, error } = await query.limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/facturas', async (req, res) => {
  const body = req.body;
  if (!body.categoria) body.categoria = body.ncf ? 'fiscal' : 'gasto';
  body.fuente = 'manual';
  body.estado = body.estado || 'verified';
  const { data, error } = await supabase.from('facturas').insert([body]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/facturas/:id', async (req, res) => {
  const { error } = await supabase.from('facturas').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.get('/api/metricas', async (req, res) => {
  const { data } = await supabase.from('facturas').select('monto, itbis, estado, categoria');
  const fiscales = data?.filter(f => f.categoria === 'fiscal') || [];
  const gastos   = data?.filter(f => f.categoria === 'gasto')  || [];
  res.json({
    fiscal: { total: fiscales.length, ventas: fiscales.reduce((a,f) => a+(f.monto||0),0), itbis: fiscales.reduce((a,f) => a+(f.itbis||0),0), pendientes: fiscales.filter(f=>f.estado!=='verified').length },
    gasto:  { total: gastos.length, monto: gastos.reduce((a,f) => a+(f.monto||0),0) }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ContaFiscal backend corriendo en puerto ${PORT}`));
