# Guía de configuración — ContaFiscal RD
## Stack 100% gratuito: Meta WhatsApp API + Google Vision + Supabase + Railway

---

## PASO 1 — Supabase (base de datos)

1. Ve a https://supabase.com y crea una cuenta gratis
2. Crea un nuevo proyecto (elige una región cercana, ej. US East)
3. Espera que termine de inicializar (~2 min)
4. Ve a **SQL Editor** y pega todo el contenido de `supabase_schema.sql`, ejecuta
5. Ve a **Settings → API** y copia:
   - `Project URL` → esto es tu `SUPABASE_URL`
   - `service_role` secret key → esto es tu `SUPABASE_SERVICE_KEY`

---

## PASO 2 — Google Vision API (OCR gratis, 1000 imágenes/mes)

1. Ve a https://console.cloud.google.com y crea una cuenta (necesitas tarjeta pero NO te cobran)
2. Crea un nuevo proyecto, ponle "ContaFiscal"
3. Activa la API: busca "Cloud Vision API" → Habilitar
4. Ve a **IAM → Cuentas de servicio → Crear cuenta de servicio**
   - Nombre: `contafiscal-vision`
   - Rol: `Cloud Vision AI User`
5. Entra a la cuenta de servicio → pestaña **Claves** → Agregar clave → JSON
6. Descarga el archivo JSON
7. Abre el JSON, cópialo todo y ponlo en una sola línea (sin saltos de línea)
8. Ese es tu `GOOGLE_CREDENTIALS_JSON`

---

## PASO 3 — WhatsApp Business API (Meta, gratis)

### 3a. Crear la app en Meta
1. Ve a https://developers.facebook.com → Mis apps → Crear app
2. Tipo: **Negocios** → Siguiente
3. Nombre: "ContaFiscal RD"
4. En el dashboard busca **WhatsApp** → Configurar

### 3b. Número de teléfono
- Meta te da un número de prueba gratis para desarrollo
- Para producción: agrega tu número real de WhatsApp Business
  (debe ser un número que NO esté en la app de WhatsApp normal)

### 3c. Tokens
- Ve a **WhatsApp → Configuración de la API**
- Copia el **Token de acceso temporal** (válido 24h para pruebas)
- Para producción: genera un **Token permanente** desde Business Settings → System Users
- Copia también el **Phone number ID**

### 3d. Verificación del webhook (después del PASO 4)
- URL del webhook: `https://tu-app.railway.app/webhook`
- Token de verificación: el valor que pusiste en `WHATSAPP_VERIFY_TOKEN`
- Suscribirse a: `messages`

---

## PASO 4 — Railway (deploy del backend)

1. Ve a https://railway.app y conecta con tu cuenta de GitHub
2. Sube este proyecto a un repositorio de GitHub
3. En Railway: **New Project → Deploy from GitHub repo**
4. Selecciona tu repositorio
5. Railway detecta automáticamente Node.js y ejecuta `npm start`
6. Ve a **Variables** y agrega todas las del archivo `.env.example`:

```
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_ID=...
WHATSAPP_VERIFY_TOKEN=mi_token_secreto_123
GOOGLE_CREDENTIALS_JSON={"type":"service_account",...}
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
APP_URL=https://tu-pagina-contafiscal.com
```

7. Railway te da una URL pública automáticamente (ej. `contafiscal.railway.app`)
8. Usa esa URL en el webhook de Meta: `https://contafiscal.railway.app/webhook`

---

## PASO 5 — Conectar la página web al backend

En el archivo `index.html` de tu página web, cambia la variable:

```javascript
const API_URL = 'https://contafiscal.railway.app'; // tu URL de Railway
```

La página ya está preparada para llamar estos endpoints:
- `GET /api/facturas` — listar con filtros
- `POST /api/facturas` — agregar manual
- `DELETE /api/facturas/:id` — eliminar
- `GET /api/metricas` — totales del dashboard

---

## Flujo completo

```
Usuario → foto por WhatsApp
       → Meta recibe y llama /webhook en Railway
       → Railway descarga la imagen
       → Google Vision extrae el texto (OCR)
       → Parser detecta NCF, RNC, monto, ITBIS
       → Se guarda en Supabase
       → WhatsApp responde con los datos extraídos
       → La página web actualiza la tabla en tiempo real
```

---

## Límites gratuitos

| Servicio        | Límite gratuito              |
|-----------------|------------------------------|
| Supabase        | 500 MB, 50,000 rows          |
| Google Vision   | 1,000 imágenes/mes           |
| Railway         | $5 crédito/mes (~500h)       |
| Meta WhatsApp   | 1,000 conversaciones/mes     |

Para un negocio pequeño esto es más que suficiente.

---

## Problemas comunes

**El webhook no se verifica:**
- Asegúrate que Railway ya terminó el deploy antes de configurar el webhook en Meta
- El `WHATSAPP_VERIFY_TOKEN` debe ser exactamente igual en Meta y en Railway

**Google Vision da error de credenciales:**
- El JSON debe estar en una sola línea sin saltos de línea
- Puedes usar: `cat credenciales.json | tr -d '\n'` en terminal

**No llegan mensajes de WhatsApp:**
- Verifica que el webhook esté suscrito a `messages` en Meta
- Revisa los logs en Railway con `railway logs`
