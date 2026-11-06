// Conexión a Supabase (proyecto de Tiempos DAC). La clave "publishable" es pública por diseño:
// la seguridad la dan las políticas RLS de supabase/schema.sql (cada perfil lee solo lo suyo; nadie escribe directo).
// Con ?local en la dirección la app lee public/local/datos.json (generado con worker/actualizar.py --local).
window.PYME_CONFIG = {
  SUPABASE_URL: 'https://lzgteejsjxrbadsqlpnd.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_3v2gGe5N9Oh1eW-9ywMb1g_3Buo8af8',
};
