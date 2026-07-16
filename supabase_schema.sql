-- ════════════════════════════════════════════════════════
-- ContaFiscal RD — Schema Supabase
-- Ejecuta esto en el SQL Editor de tu proyecto Supabase
-- ════════════════════════════════════════════════════════

-- Si ya tienes la tabla, solo agrega la columna nueva:
-- ALTER TABLE facturas ADD COLUMN IF NOT EXISTS categoria text default 'fiscal';
-- Luego actualiza los registros sin NCF:
-- UPDATE facturas SET categoria = 'gasto' WHERE ncf IS NULL OR ncf = '';

-- ── Crear tabla desde cero ───────────────────────────────
create table if not exists facturas (
  id              bigserial primary key,
  ncf             text,
  tipo_ncf        text,
  rnc             text,
  razon_social    text,
  fecha           date,
  monto           numeric(12,2),
  itbis           numeric(12,2),
  estado          text default 'verified',   -- verified | pending | error
  categoria       text default 'fiscal',     -- fiscal | gasto  ← NUEVO
  fuente          text default 'manual',     -- whatsapp | manual
  telefono_emisor text,
  texto_ocr       text,
  fecha_registro  timestamptz default now(),
  created_at      timestamptz default now()
);

-- Índices
create index if not exists idx_facturas_ncf       on facturas (ncf);
create index if not exists idx_facturas_rnc       on facturas (rnc);
create index if not exists idx_facturas_fecha     on facturas (fecha);
create index if not exists idx_facturas_estado    on facturas (estado);
create index if not exists idx_facturas_categoria on facturas (categoria);
create index if not exists idx_facturas_created   on facturas (created_at desc);

-- Row Level Security
alter table facturas enable row level security;
drop policy if exists "Service role full access" on facturas;
create policy "Service role full access" on facturas using (true) with check (true);

-- ── Vista 606: comprobantes fiscales de ventas ───────────
create or replace view reporte_606 as
  select
    id,
    rnc             as "RNC/Cedula",
    ncf             as "NCF",
    tipo_ncf        as "Tipo NCF",
    fecha           as "Fecha",
    monto           as "Monto Facturado",
    itbis           as "ITBIS Facturado",
    estado
  from facturas
  where categoria = 'fiscal'
  order by fecha desc;

-- ── Vista 607: comprobantes fiscales de compras ──────────
create or replace view reporte_607 as
  select
    id,
    rnc             as "RNC Suplidor",
    ncf             as "NCF",
    tipo_ncf        as "Tipo",
    fecha           as "Fecha",
    monto           as "Monto",
    itbis           as "ITBIS",
    estado
  from facturas
  where categoria = 'fiscal'
  order by fecha desc;

-- ── Vista gastos: facturas sin NCF ───────────────────────
create or replace view reporte_gastos as
  select
    id,
    razon_social    as "Empresa/Persona",
    fecha           as "Fecha",
    monto           as "Monto RD$",
    fuente          as "Fuente",
    texto_ocr       as "Descripcion"
  from facturas
  where categoria = 'gasto'
  order by fecha desc;
