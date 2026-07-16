const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const vision = new ImageAnnotatorClient({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
});

// ─── Webhook verificación Meta ────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verificado ✓');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Webhook recepción de mensajes ───────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const tipo = message.type;

    if (tipo !== 'image' && tipo !== 'document') {
      await sendWA(from,
        '📋 Envía una *foto o imagen* de tu factura para registrarla.\n\n' +
        'Acepto facturas *con o sin* comprobante fiscal (NCF).'
      );
      return;
    }

    await sendWA(from, '⏳ Analizando tu factura... un momento.');

    // Descargar imagen
    const mediaId = tipo === 'image' ? message.image.id : message.document.id;
    const imageBuffer = await downloadMedia(mediaId);

    // OCR con Google Vision
    const texto = await ocr(imageBuffer);

    // Parsear datos
    const factura = parsear(texto);
    factura.telefono_emisor = from;
    factura.fecha_registro  = new Date().toISOString();
    factura.fuente          = 'whatsapp';

    // ── Clasificar: fiscal o gasto ──────────────────────────────────────────
    if (factura.ncf) {
      factura.categoria = 'fiscal';
      factura.estado    = 'verified';
    } else {
      factura.categoria = 'gasto';
      factura.estado    = 'verified';
    }

    // Guardar en Supabase
    const { data, error } = await supabase
      .from('facturas')
      .insert([factura])
      .select()
      .single();

    if (error) throw error;

    // Respuesta diferenciada según categoría
    const respuesta = factura.categoria === 'fiscal'
      ? respuestaFiscal(factura)
      : respuestaGasto(factura);

    await sendWA(from, respuesta);
    console.log(`Factura guardada [${factura.categoria}] id:${data.id}`);

  } catch (err) {
    console.error('Error procesando mensaje:', err.message);
  }
});

// ─── Descargar imagen de WhatsApp ────────────────────────────────────────────
async function downloadMedia(mediaId) {
  const urlRes = await axios.get(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
  );
  const imgRes = await axios.get(urlRes.data.url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    responseType: 'arraybuffer'
  });
  return Buffer.from(imgRes.data);
}

// ─── OCR con Google Vision ────────────────────────────────────────────────────
async function ocr(imageBuffer) {
  const [result] = await vision.textDetection({ image: { content: imageBuffer } });
  return result.textAnnotations?.[0]?.description || '';
}

// ─── Parser de facturas dominicanas ──────────────────────────────────────────
function parsear(texto) {
  const lineas    = texto.split('\n').map(l => l.trim()).filter(Boolean);
  const textoUp   = texto.toUpperCase();

  // NCF: B01-B15, E31, etc.
  const ncfMatch  = texto.match(/[BE]\d{2}\d{8,11}/i);
  const ncf       = ncfMatch ? ncfMatch[0].toUpperCase() : null;

  // Tipo NCF
  let tipo_ncf = null;
  if (ncf) {
    const cod  = ncf.substring(0, 3).toUpperCase();
    const mapa = {
      B01: 'Crédito Fiscal',
      B02: 'Consumidor Final',
      B14: 'Gubernamental',
      B15: 'Regímenes Especiales',
      E31: 'Electrónico CF',
      E32: 'Electrónico CF',
      E33: 'Electrónico Especial',
      E34: 'Electrónico Gubernamental',
      E41: 'Electrónico Compras',
      E43: 'Electrónico Gastos Menores',
      E44: 'Electrónico Régimen Especial',
      E45: 'Electrónico Gubernamental'
    };
    tipo_ncf = mapa[cod] || cod;
  }

  // RNC: 1-XX-XXXXX-X o 9 dígitos seguidos
  const rncMatch = texto.match(/\d{1}-\d{2}-\d{5}-\d|\b\d{9}\b/);
  const rnc      = rncMatch ? rncMatch[0] : null;

  // Monto total
  let monto = null;
  const montoPatrones = [
    /total\s*rd?\$?\s*([\d,\.]+)/i,
    /total\s*rds\s*([\d,\.]+)/i,
    /importe\s*rd?\$?\s*([\d,\.]+)/i,
    /monto\s*rd?\$?\s*([\d,\.]+)/i,
    /total\s*:\s*([\d,\.]+)/i,
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
    // Solo calcular ITBIS automático si tiene NCF
    itbis = Math.round(monto * 0.18 * 100) / 100;
  }

  // Fecha: DD/MM/YYYY o DD-MM-YYYY o YYYY-MM-DD
  let fecha = null;
  const f1 = texto.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  const f2 = texto.match(/(\d{4})[\/\-](\d{2})[\/\-](\d{2})/);
  if (f2) {
    fecha = f2[0];
  } else if (f1) {
    const [, d, m, y] = f1;
    fecha = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // Razón social / empresa
  let razon_social = null;
  const ignorar = /RNC|NCF|ITBIS|TOTAL|TEL|FAX|CORREO|EMAIL|WWW|HTTP|FECHA|FACT|HORA|DIRECCI|ZONA|C\/|NO\.|NUM/i;
  for (const linea of lineas.slice(0, 12)) {
    if (linea.length > 4 && linea.length < 60 && !/^\d/.test(linea) && !ignorar.test(linea)) {
      razon_social = linea;
      break;
    }
  }

  return {
    ncf,
    tipo_ncf,
    rnc,
    razon_social,
    fecha,
    monto,
    itbis,
    texto_ocr: texto.substring(0, 600)
  };
}

// ─── Respuesta para comprobante fiscal (con NCF) ──────────────────────────────
function respuestaFiscal(f) {
  const lines = [
    '✅ *Comprobante fiscal registrado*\n',
    `🔢 NCF: \`${f.ncf}\``,
    `📄 Tipo: ${f.tipo_ncf}`,
  ];
  if (f.rnc)          lines.push(`🏢 RNC: ${f.rnc}`);
  if (f.razon_social) lines.push(`🏷️ Empresa: ${f.razon_social}`);
  if (f.fecha)        lines.push(`📅 Fecha: ${f.fecha}`);
  if (f.monto)        lines.push(`💰 Monto: RD$ ${f.monto.toLocaleString()}`);
  if (f.itbis)        lines.push(`🧾 ITBIS: RD$ ${f.itbis.toLocaleString()}`);
  lines.push('\n📊 Este comprobante aplica para el reporte 606/607 de la DGI.');
  lines.push(`🔗 Ver panel: ${process.env.APP_URL}`);
  return lines.join('\n');
}

// ─── Respuesta para gasto simple (sin NCF) ───────────────────────────────────
function respuestaGasto(f) {
  const lines = [
    '🧾 *Gasto registrado*\n',
    '⚠️ Esta factura *no tiene NCF* — se registró como gasto general.',
    '_(No aplica para reportes DGI ni crédito de ITBIS)_\n',
  ];
  if (f.razon_social) lines.push(`🏷️ Empresa: ${f.razon_social}`);
  if (f.fecha)        lines.push(`📅 Fecha: ${f.fecha}`);
  if (f.monto)        lines.push(`💰 Monto: RD$ ${f.monto?.toLocaleString() || 'no detectado'}`);
  lines.push('\n📊 Puedes verlo en la sección *Gastos generales* de tu panel.');
  lines.push(`🔗 Ver panel: ${process.env.APP_URL}`);
  return lines.join('\n');
}

// ─── Enviar mensaje WhatsApp ──────────────────────────────────────────────────
async function sendWA(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
  );
}

// ─── API REST para la página web ─────────────────────────────────────────────

// Comprobantes fiscales (con NCF)
app.get('/api/fiscales', async (req, res) => {
  const { tipo, estado, desde, hasta, q } = req.query;
  let query = supabase
    .from('facturas')
    .select('*')
    .eq('categoria', 'fiscal')
    .order('created_at', { ascending: false });

  if (tipo)   query = query.eq('tipo_ncf', tipo);
  if (estado) query = query.eq('estado', estado);
  if (desde)  query = query.gte('fecha', desde);
  if (hasta)  query = query.lte('fecha', hasta);
  if (q)      query = query.or(`rnc.ilike.%${q}%,razon_social.ilike.%${q}%,ncf.ilike.%${q}%`);

  const { data, error } = await query.limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Gastos generales (sin NCF)
app.get('/api/gastos', async (req, res) => {
  const { desde, hasta, q } = req.query;
  let query = supabase
    .from('facturas')
    .select('*')
    .eq('categoria', 'gasto')
    .order('created_at', { ascending: false });

  if (desde) query = query.gte('fecha', desde);
  if (hasta) query = query.lte('fecha', hasta);
  if (q)     query = query.or(`razon_social.ilike.%${q}%`);

  const { data, error } = await query.limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Todas las facturas (sin filtro de categoría)
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

// Agregar factura manual
app.post('/api/facturas', async (req, res) => {
  const body = req.body;
  // Auto-clasificar si no viene categoría
  if (!body.categoria) {
    body.categoria = body.ncf ? 'fiscal' : 'gasto';
  }
  body.fuente = 'manual';
  body.estado = body.estado || 'verified';

  const { data, error } = await supabase.from('facturas').insert([body]).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Eliminar factura
app.delete('/api/facturas/:id', async (req, res) => {
  const { error } = await supabase.from('facturas').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Métricas separadas por categoría
app.get('/api/metricas', async (req, res) => {
  const { data } = await supabase
    .from('facturas')
    .select('monto, itbis, estado, categoria');

  const fiscales = data?.filter(f => f.categoria === 'fiscal') || [];
  const gastos   = data?.filter(f => f.categoria === 'gasto')  || [];

  res.json({
    fiscal: {
      total:     fiscales.length,
      ventas:    fiscales.reduce((a, f) => a + (f.monto || 0), 0),
      itbis:     fiscales.reduce((a, f) => a + (f.itbis || 0), 0),
      pendientes: fiscales.filter(f => f.estado !== 'verified').length,
    },
    gasto: {
      total:  gastos.length,
      monto:  gastos.reduce((a, f) => a + (f.monto || 0), 0),
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ContaFiscal backend corriendo en puerto ${PORT}`));
