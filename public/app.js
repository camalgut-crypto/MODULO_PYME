// Módulo PYME: cartera del equipo PYME por perfil (gerente país, jefe del equipo, promotor) + administrador de personal.
// La seguridad está en Supabase (RLS): el promotor solo recibe sus créditos y nunca recibe saldo ni saldo pagaré.
const CFG = window.PYME_CONFIG;
const PARAMS = new URLSearchParams(location.search);
const LOCAL = PARAMS.has('local');
const sb = LOCAL ? null : window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
const $ = id => document.getElementById(id);
const ok = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

const DOMINIO = '@tiemposdac.local';
const CLAVE_INICIAL = '12345678';
const ROLES = { admin: 'Administrador', gerente: 'Gerente país', jefe: 'Jefe del equipo', promotor: 'Promotor' };
const slug = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .trim().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
const titulo = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/(^|\s)\S/g, c => c.toUpperCase());

// Campos que ven los promotores (en este orden); jefe y gerente ven además saldo pagaré y saldo
const COLS = [
  { k: 'llave', t: 'Numero de llave', cab: true },
  { k: 'cedula', t: 'Cedula' },
  { k: 'nombre_cliente', t: 'Nombre del cliente' },
  { k: 'empresa_genesis', t: 'Empresa Genesis' },
  { k: 'cuotas_mora', t: 'Cuotas en mora', tipo: 'ent' },
  { k: 'monto_cuota_mora', t: 'Monto cuota en mora', tipo: 'din' },
  { k: 'cuotas_pagadas', t: 'Cuotas pagadas', tipo: 'ent' },
  { k: 'dias_mora_mc', t: 'Dias Mora MC', tipo: 'mora' },
  { k: 'fecha_desembolso', t: 'Fecha de desembolso', tipo: 'fecha' },
  { k: 'total_pagado', t: 'Total pagado desde desembolso', tipo: 'din' },
  { k: 'total_interes', t: 'Pagado a interes', tipo: 'din' },
  { k: 'total_mora', t: 'Pagado a mora', tipo: 'din' },
  { k: 'total_ocargos', t: 'Pagado a otros cargos', tipo: 'din' },
  { k: 'total_capital', t: 'Pagado a capital', tipo: 'din' },
  { k: 'dias_mora', t: 'Dias de mora', tipo: 'mora' },
  { k: 'promotor', t: 'Promotor' },
  { k: 'pct_amortizado', t: '% amortizado', tipo: 'pct' },
  { k: 'tel_domicilio', t: 'Telefono domicilio', tipo: 'tel' },
  { k: 'tel_negocio', t: 'Telefono negocio', tipo: 'tel' },
  { k: 'dir_domicilio', t: 'Direccion domicilio', tipo: 'largo' },
  { k: 'dir_negocio', t: 'Direccion negocio', tipo: 'largo' },
];
const COLS_SALDO = [
  { k: 'saldopagare', t: 'saldopagare', tipo: 'din' },
  { k: 'saldo', t: 'saldo', tipo: 'din' },
];
const FUENTES = [['f_loan_tape', 'Loan tape', true], ['f_cendoc', 'CENDOC'], ['f_mccollect', 'MCCOLLECT'], ['f_chirico', 'CHIRICO']];

const S = { perfil: null, cartera: [], perfiles: [], catalogo: [], ultima: null, carga: null,
            tab: 'cartera', orden: { k: 'dias_mora_mc', asc: false } };
const veTodo = () => ['admin', 'gerente', 'jefe'].includes(S.perfil?.rol);
const administra = () => ['admin', 'jefe'].includes(S.perfil?.rol);
const cols = () => veTodo() ? [...COLS, ...COLS_SALDO] : COLS;

// ---------- Formatos ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nf2 = new Intl.NumberFormat('es-NI', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('es-NI', { maximumFractionDigits: 0 });
const din = v => nf2.format(v);
const pct = v => `${(100 * v).toLocaleString('es-NI', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
const fecha = v => { const [a, m, d] = String(v).slice(0, 10).split('-'); return `${d}/${m}/${a}`; };
const fechaHora = v => new Date(v).toLocaleString('es-NI', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const claseMora = d => d == null ? '' : d <= 0 ? '' : d <= 30 ? 'm1' : d <= 60 ? 'm31' : 'm61';
const num = v => (v == null || v === '' ? 0 : +v);

function telefonos(v) {
  // "25227412/88137108", "87838967*81648579MK": se enlaza cada número de 8 dígitos (se omite 00000000)
  const ns = (String(v).match(/\d{8}/g) || []).filter(n => !/^0+$/.test(n));
  if (!ns.length) return `<span class="muted">${esc(v)}</span>`;
  return ns.map(n => `<a class="tel" href="tel:+505${n}">${n.slice(0, 4)}-${n.slice(4)}</a>`).join(' · ');
}

function celda(c, r) {
  const v = r[c.k];
  const l = ` data-l="${esc(c.t)}"`;
  if (v == null || v === '') return `<td class="nada"${l}>—</td>`;
  switch (c.tipo) {
    case 'din': return `<td class="num"${l}>${din(v)}</td>`;
    case 'ent': return `<td class="num"${l}>${nf0.format(v)}</td>`;
    case 'pct': return `<td class="num"${l}>${pct(v)}</td>`;
    case 'fecha': return `<td${l}>${fecha(v)}</td>`;
    case 'mora': return `<td class="num"${l}><span class="mora ${claseMora(v)}">${v}</span></td>`;
    case 'tel': return `<td${l}>${telefonos(v)}</td>`;
    case 'largo': return `<td class="largo"${l}>${esc(v)}</td>`;
    default: return `<td${c.cab ? ' class="cab"' : ''}${l}>${esc(v)}</td>`;
  }
}

// ---------- Sesión ----------
async function perfilActual() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return null;
  return ok(await sb.from('pyme_perfiles').select('*').eq('id', data.session.user.id).maybeSingle());
}

function mostrarLogin(msg = '') {
  $('app').hidden = true;
  $('login').hidden = false;
  $('flog').hidden = false;
  $('fclave').hidden = true;
  $('lmsg').textContent = msg;
}

$('flog').addEventListener('submit', async e => {
  e.preventDefault();
  const clave = $('lp').value;
  try {
    ok(await sb.auth.signInWithPassword({ email: slug($('lu').value) + DOMINIO, password: clave }));
    const p = await perfilActual();
    if (!p || !p.activo) { await sb.auth.signOut(); return mostrarLogin('Tu usuario no tiene acceso al Módulo PYME. Pedíselo a tu jefe de equipo.'); }
    S.perfil = p;
    $('lp').value = '';
  } catch {
    return mostrarLogin('Usuario o contraseña incorrectos');
  }
  if (clave === CLAVE_INICIAL) {  // con la contraseña temporal no se entra hasta elegir una propia
    $('flog').hidden = true;
    $('fclave').hidden = false;
    $('cmsg').textContent = '';
    return $('cn1').focus();
  }
  await iniciar();
});

$('fclave').addEventListener('submit', async e => {
  e.preventDefault();
  const n1 = $('cn1').value, n2 = $('cn2').value;
  if (n1.length < 8) return ($('cmsg').textContent = 'La contraseña debe tener al menos 8 caracteres.');
  if (n1 === CLAVE_INICIAL) return ($('cmsg').textContent = 'Usá una contraseña distinta de la temporal.');
  if (n1 !== n2) return ($('cmsg').textContent = 'Las dos contraseñas no coinciden.');
  try {
    ok(await sb.auth.updateUser({ password: n1 }));
    $('cn1').value = $('cn2').value = '';
    await iniciar();
  } catch (err) { $('cmsg').textContent = err.message; }
});

async function iniciar() {
  $('login').hidden = true;
  $('app').hidden = false;
  $('yoNombre').textContent = S.perfil.nombre;
  $('yoRol').textContent = ROLES[S.perfil.rol] || '';
  $('tabResumen').hidden = !veTodo();
  $('tabPersonal').hidden = !administra();
  $('panelUsuario').hidden = S.perfil.rol !== 'admin';
  $('lblPromotor').hidden = !veTodo();
  $('btnDescargar').hidden = !veTodo();
  $('btnClave').hidden = $('btnSalir').hidden = LOCAL;
  await cargar();
}

// ---------- Datos ----------
async function leerTodo(tabla, orden, columnas = '*') {
  const filas = [];  // PostgREST entrega como máximo 1000 filas por llamada
  for (let i = 0; ; i += 1000) {
    const p = ok(await sb.from(tabla).select(columnas).order(orden).range(i, i + 999));
    filas.push(...p);
    if (p.length < 1000) return filas;
  }
}

async function cargar() {
  try {
    if (LOCAL) {
      const d = await (await fetch('local/datos.json', { cache: 'no-store' })).json();
      S.cartera = S.perfil.rol === 'promotor' ? d.cartera.filter(r => r.cedula_promotor === S.perfil.cedula_promotor)
        .map(r => { const { saldo, saldopagare, ...x } = r; return x; }) : d.cartera;
      S.ultima = d.ultima_carga; S.carga = null; S.catalogo = d.catalogo;
      const ceds = [...new Set(d.cartera.map(r => r.cedula_promotor))];
      S.perfiles = ceds.map((c, i) => { const p = d.catalogo.find(x => x.cedula_promotor === c);
        return { id: String(i), nombre: titulo(p?.promotor || c), usuario: slug(p?.promotor || c), rol: 'promotor', cedula_promotor: c, activo: true, creado_por: 'instalación' }; });
    } else {
      const pedidos = [leerTodo('pyme_cartera', 'llave'),
        sb.from('pyme_config').select('valor').eq('clave', 'ultima_carga').then(ok),
        sb.from('pyme_cargas').select('*').order('id', { ascending: false }).limit(1).then(ok)];
      if (veTodo()) pedidos.push(leerTodo('pyme_saldos', 'llave'), leerTodo('pyme_perfiles', 'nombre'));
      if (administra()) pedidos.push(leerTodo('pyme_catalogo', 'promotor'));
      const [cartera, conf, carga, saldos = [], perfiles = [], catalogo = []] = await Promise.all(pedidos);
      const sal = new Map(saldos.map(s => [s.llave, s]));
      S.cartera = cartera.map(r => ({ ...r, ...(sal.get(r.llave) || {}) }));
      S.ultima = conf[0]?.valor || null; S.carga = carga[0] || null;
      S.perfiles = perfiles; S.catalogo = catalogo;
      S.equipos = veTodo() ? await equiposConectados() : [];
    }
  } catch (err) {
    aviso(`No se pudieron leer los datos: ${err.message}`, true);
  }
  pintarFrescura();
  armarFiltros();
  pintar();
}

// Fecha de los datos de origen y avisos si no son del día (nunca se muestra un reporte viejo sin avisar)
function pintarFrescura() {
  const u = S.ultima;
  if (!u) { $('frescura').innerHTML = '<span>Todavía no hay datos cargados.</span>'; return aviso('Todavía no hay datos cargados: la primera carga se hace a las 7:30 a. m.'); }
  const f = u.fuentes || {};
  const ayer = new Date(Date.now() - 864e5);
  const minimo = `${ayer.getFullYear()}-${String(ayer.getMonth() + 1).padStart(2, '0')}-${String(ayer.getDate()).padStart(2, '0')}`;
  $('frescura').innerHTML = `<span>Datos generados el <b>${fechaHora(u.generado)}</b></span>` +
    FUENTES.map(([k, n, mensual]) => f[k] ? `<span class="f ${mensual ? 'mensual' : f[k] < minimo ? 'vieja' : ''}" title="${mensual ? 'Corte mensual del loan tape' : 'Fecha de los datos de origen'}">${n} ${fecha(f[k])}${mensual ? ' (corte mensual)' : ''}</span>` : '').join('') +
    (veTodo() && !LOCAL ? `<span class="f ${S.equipos?.length ? '' : 'vieja'}" style="margin-left:auto">${S.equipos?.length ? `PC de carga conectada: ${S.equipos.map(e => esc(e.equipo)).join(', ')}` : 'Ninguna PC de carga conectada'}</span>` : '');
  const msgs = [];
  let error = false;
  if (String(u.generado).slice(0, 10) !== hoyISO()) {
    msgs.push(`Estos datos son del ${fechaHora(u.generado)}: la carga de hoy (7:30 a. m.) todavía no se hizo o no terminó.`);
    error = true;
  }
  if (S.carga?.estado === 'error' && new Date(S.carga.inicio) > new Date(u.generado)) {
    msgs.push(veTodo() ? `La última carga falló (intento ${S.carga.intento}): ${S.carga.mensaje}` : 'La última carga no terminó; avisale a tu jefe de equipo.');
    error = true;
  }
  if (u.estado === 'aviso') msgs.push(u.mensaje || 'Algunos datos de origen no son del día.');
  aviso(msgs.join(' '), error);
}

function aviso(texto, error = false) {
  $('aviso').hidden = !texto;
  $('aviso').textContent = texto || '';
  $('aviso').classList.toggle('error', error);
}

// ---------- Cartera ----------
function armarFiltros() {
  const el = $('fPromotor'), actual = el.value;
  const ps = [...new Set(S.cartera.map(r => r.promotor).filter(Boolean))].sort();
  el.innerHTML = '<option value="">Todos</option>' + ps.map(p => `<option>${esc(p)}</option>`).join('');
  if (ps.includes(actual)) el.value = actual;
  $('cntCartera').textContent = S.cartera.length.toLocaleString('es-NI');
}

function base() {
  const p = $('fPromotor').value;
  return S.cartera.filter(r => !p || r.promotor === p);
}

function filtrar() {
  const q = $('fBuscar').value.trim().toUpperCase();
  const sit = $('fSituacion').value;
  return base().filter(r => {
    const d = r.dias_mora_mc;
    if (sit === 'dia' && d > 0) return false;
    if (sit === 'mora' && !(d > 0)) return false;
    if (sit === 'm1' && !(d >= 1 && d <= 30)) return false;
    if (sit === 'm31' && !(d >= 31 && d <= 60)) return false;
    if (sit === 'm61' && !(d > 60)) return false;
    if (sit === 'sinpago' && r.total_pagado != null) return false;
    return !q || [r.llave, r.nombre_cliente, r.cedula, r.empresa_genesis, r.tel_domicilio, r.tel_negocio, r.promotor]
      .some(v => v != null && String(v).toUpperCase().includes(q));
  });
}

function ordenar(filas) {
  const { k, asc } = S.orden;
  return filas.sort((a, b) => {
    const x = a[k], y = b[k];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
  });
}

function totales(filas) {
  const t = { n: filas.length, mora: 0, vencido: 0, pagado: 0, capital: 0, saldo: 0, pagare: 0, pctSum: 0, pctN: 0, sinPago: 0 };
  for (const r of filas) {
    if (r.dias_mora_mc > 0) t.mora++;
    if (r.total_pagado == null) t.sinPago++;
    t.vencido += num(r.monto_cuota_mora); t.pagado += num(r.total_pagado); t.capital += num(r.total_capital);
    t.saldo += num(r.saldo); t.pagare += num(r.saldopagare);
    if (r.pct_amortizado != null) { t.pctSum += +r.pct_amortizado; t.pctN++; }
  }
  return t;
}

function pintarSaludo(t) {
  const nombre = (S.perfil.nombre || '').split(' ')[0];
  const alDia = t.n - t.mora;
  const promotores = new Set(S.cartera.map(r => r.cedula_promotor)).size;
  const msg = S.perfil.rol === 'promotor'
    ? (t.mora === 0 && t.n ? '¡Toda tu cartera está al día! Así se Impactan Vidas.' : `Tenés ${alDia} de ${t.n} créditos al día. Cada cliente que acompañás es un negocio que sigue creciendo.`)
    : `Cartera del equipo PYME: ${promotores} promotores y ${t.n} créditos.`;
  $('saludo').hidden = false;
  $('saludo').innerHTML = `<div><b>¡HOLA, <span>${esc(nombre)}</span>!</b>${esc(msg)}</div>
    <img src="img/${t.mora === 0 && t.n ? 'prestamito_festejando' : 'prestamito_asesor'}.png" alt="">`;
}

function kpis() {
  const t = totales(base());
  pintarSaludo(totales(S.cartera));
  const tarjetas = [
    ['Créditos', nf0.format(t.n), `${nf0.format(t.n - t.mora)} al día`, 'navy'],
    ['En mora', nf0.format(t.mora), t.n ? `${pct(t.mora / t.n)} de la cartera` : '', 'naranja'],
    ['Monto vencido', din(t.vencido), 'para ponerse al día', 'amarillo'],
    ['Total pagado', din(t.pagado), `${din(t.capital)} a capital`, ''],
    ['% amortizado', t.pctN ? pct(t.pctSum / t.pctN) : '—', 'promedio por crédito', 'cielo'],
  ];
  if (veTodo()) tarjetas.push(['Saldo', din(t.saldo), `de ${din(t.pagare)} en pagarés`, 'lima']);
  $('kpis').innerHTML = tarjetas.map(([l, v, s, c]) =>
    `<div class="kpi ${c}"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
}

function pintarCartera() {
  kpis();
  const cs = cols();
  const filas = ordenar(filtrar());
  $('thead').innerHTML = '<tr>' + cs.map(c =>
    `<th data-k="${c.k}" class="${['din', 'ent', 'pct', 'mora'].includes(c.tipo) ? 'num' : ''}">${c.t}${S.orden.k === c.k ? `<span class="flecha">${S.orden.asc ? '▲' : '▼'}</span>` : ''}</th>`).join('') + '</tr>';
  $('tbody').innerHTML = filas.map(r => `<tr class="${r.dias_mora_mc > 0 ? 'en-mora' : ''}">` + cs.map(c => celda(c, r)).join('') + '</tr>').join('');
  $('tbody').closest('table').classList.add('tarjetas');
  $('vacio').hidden = filas.length > 0;
}

// ---------- Resumen por promotor ----------
function resumen() {
  const g = new Map();
  for (const r of S.cartera) {
    if (!g.has(r.promotor)) g.set(r.promotor, []);
    g.get(r.promotor).push(r);
  }
  return [...g].map(([p, fs]) => ({ promotor: p, ...totales(fs) })).sort((a, b) => b.n - a.n);
}

function pintarResumen() {
  const cab = ['Promotor', 'Créditos', 'En mora', '% en mora', 'Monto vencido', 'Total pagado', 'Pagado a capital', 'Saldo pagaré', 'Saldo', '% amortizado'];
  $('rhead').innerHTML = '<tr>' + cab.map((c, i) => `<th class="${i ? 'num' : ''}">${c}</th>`).join('') + '</tr>';
  const fila = (t, nombre) => [
    `<td class="cab" data-l="Promotor">${esc(nombre)}</td>`,
    `<td class="num" data-l="Créditos">${nf0.format(t.n)}</td>`,
    `<td class="num" data-l="En mora">${nf0.format(t.mora)}</td>`,
    `<td class="num" data-l="% en mora">${t.n ? pct(t.mora / t.n) : '—'}</td>`,
    `<td class="num" data-l="Monto vencido">${din(t.vencido)}</td>`,
    `<td class="num" data-l="Total pagado">${din(t.pagado)}</td>`,
    `<td class="num" data-l="Pagado a capital">${din(t.capital)}</td>`,
    `<td class="num" data-l="Saldo pagaré">${din(t.pagare)}</td>`,
    `<td class="num" data-l="Saldo">${din(t.saldo)}</td>`,
    `<td class="num" data-l="% amortizado">${t.pagare ? pct(1 - t.saldo / t.pagare) : '—'}</td>`].join('');
  $('rbody').innerHTML = resumen().map(t => `<tr class="clic" data-p="${esc(t.promotor)}">${fila(t, t.promotor)}</tr>`).join('');
  $('rfoot').innerHTML = `<tr>${fila(totales(S.cartera), 'Total del equipo')}</tr>`;
  $('rbody').closest('table').classList.add('tarjetas');
}

$('rbody').addEventListener('click', e => {
  const tr = e.target.closest('tr[data-p]');
  if (!tr) return;
  $('fPromotor').value = tr.dataset.p;
  cambiarTab('cartera');
});

// ---------- Administrador de personal ----------
function pintarPersonal() {
  const admin = S.perfil.rol === 'admin';
  const enEquipo = new Set(S.perfiles.map(p => p.cedula_promotor).filter(Boolean));
  $('pLista').innerHTML = S.catalogo.filter(c => !enEquipo.has(c.cedula_promotor))
    .map(c => `<option value="${esc(c.promotor.replace(/\s+/g, ' '))} · ${esc(c.cedula_promotor)}">${esc(c.tipo_promotor || '')} · última solicitud ${c.ultima_solicitud ? fecha(c.ultima_solicitud) : '—'}</option>`).join('');
  const creditos = new Map();
  for (const r of S.cartera) creditos.set(r.cedula_promotor, (creditos.get(r.cedula_promotor) || 0) + 1);
  const orden = { admin: 0, gerente: 1, jefe: 2, promotor: 3 };
  const lista = [...S.perfiles].sort((a, b) => orden[a.rol] - orden[b.rol] || a.nombre.localeCompare(b.nombre));
  $('tpersonal').innerHTML = lista.map(u => {
    const puede = admin || u.rol === 'promotor';
    const rol = admin && u.rol !== 'promotor'
      ? `<select data-campo="rol">${['admin', 'gerente', 'jefe'].map(k => `<option value="${k}"${k === u.rol ? ' selected' : ''}>${ROLES[k]}</option>`).join('')}</select>`
      : ROLES[u.rol];
    return `<tr data-id="${u.id}" data-rol="${u.rol}">
      <td class="cab" data-l="Nombre">${esc(u.nombre)}<div class="small muted">ingresa como: ${esc(u.usuario)}</div></td>
      <td data-l="Perfil">${rol}</td>
      <td data-l="Cédula promotor">${u.cedula_promotor ? esc(u.cedula_promotor) : '<span class="nada">—</span>'}</td>
      <td class="num" data-l="Créditos">${u.rol === 'promotor' ? nf0.format(creditos.get(u.cedula_promotor) || 0) : ''}</td>
      <td data-l="Activo">${puede ? `<input type="checkbox" data-campo="activo"${u.activo ? ' checked' : ''}${u.id === S.perfil.id ? ' disabled' : ''}>` : (u.activo ? 'Sí' : 'No')}</td>
      <td data-l="Agregado por">${esc(u.creado_por || '')}</td>
      <td data-l="">${puede && u.id !== S.perfil.id ? '<button class="btn mini lin" data-acc="clave">Restablecer contraseña</button>' : ''}</td></tr>`;
  }).join('');
  $('tpersonal').closest('table').classList.add('tarjetas');
}

function promotorElegido() {
  const v = $('pBuscar').value.trim();
  const ced = (v.match(/·\s*([0-9A-Za-z]{4,20})$/) || [])[1] || (/^[0-9A-Za-z]{4,20}$/.test(v) ? v.toUpperCase() : null);
  return ced ? { cedula: ced, cat: S.catalogo.find(c => c.cedula_promotor === ced) } : null;
}

$('pBuscar').addEventListener('input', () => {
  const p = promotorElegido();
  if (p?.cat && !$('pNombre').dataset.editado) $('pNombre').value = titulo(p.cat.promotor);
  $('pInfo').innerHTML = p?.cat
    ? `<b>${esc(p.cat.promotor)}</b> · cédula ${esc(p.cedula)} · ${esc(p.cat.tipo_promotor || '')} · ${nf0.format(p.cat.solicitudes)} solicitudes en 12 meses. Revisá el nombre para ingresar (por ejemplo, nombres y luego apellidos).`
    : 'La lista trae a quienes colocaron solicitudes en los últimos 12 meses. El promotor entra con el nombre que pongás aquí y la contraseña temporal <b>12345678</b>, y ve solo los créditos que él colocó.';
});
$('pNombre').addEventListener('input', () => { $('pNombre').dataset.editado = $('pNombre').value ? '1' : ''; });

$('fpromotor').addEventListener('submit', async e => {
  e.preventDefault();
  const p = promotorElegido();
  if (!p) return alert('Elegí un promotor de la lista (o escribí su cédula).');
  const nombre = $('pNombre').value.trim().replace(/\s+/g, ' ');
  if (LOCAL) return alert('Vista previa local: no se guardan cambios.');
  try {
    ok(await sb.rpc('pyme_crear_usuario', { p_usuario: slug(nombre), p_nombre: nombre, p_rol: 'promotor', p_cedula: p.cedula, p_password: CLAVE_INICIAL }));
    $('pBuscar').value = $('pNombre').value = ''; $('pNombre').dataset.editado = '';
    alert(`Listo: ${nombre} ya es parte del equipo. Ingresa con su nombre completo y la contraseña ${CLAVE_INICIAL} (si ya usaba Tiempos DAC o Auditores, con su contraseña de siempre). Su cartera aparece desde la carga de mañana a las 7:30 a. m.`);
    await recargarPerfiles();
  } catch (err) { alert(err.message); }
});

$('fusuario').addEventListener('submit', async e => {
  e.preventDefault();
  const nombre = $('uNombre').value.trim().replace(/\s+/g, ' ');
  if (LOCAL) return alert('Vista previa local: no se guardan cambios.');
  try {
    ok(await sb.rpc('pyme_crear_usuario', { p_usuario: slug(nombre), p_nombre: nombre, p_rol: $('uRol').value, p_cedula: null, p_password: CLAVE_INICIAL }));
    $('uNombre').value = '';
    alert(`Usuario creado. Ingresa con su nombre completo "${nombre}" y la contraseña ${CLAVE_INICIAL}; la primera vez se le pide cambiarla (si ya usaba Tiempos DAC o Auditores, entra con su contraseña de siempre).`);
    await recargarPerfiles();
  } catch (err) { alert(err.message); }
});

async function recargarPerfiles() {
  S.perfiles = await leerTodo('pyme_perfiles', 'nombre');
  pintarPersonal();
}

$('tpersonal').addEventListener('change', async e => {
  const tr = e.target.closest('tr[data-id]');
  if (!tr) return;
  if (LOCAL) { alert('Vista previa local: no se guardan cambios.'); return pintarPersonal(); }
  const rol = tr.querySelector('[data-campo=rol]')?.value || tr.dataset.rol;
  const activo = tr.querySelector('[data-campo=activo]')?.checked ?? true;
  try {
    ok(await sb.rpc('pyme_editar_usuario', { p_id: tr.dataset.id, p_rol: rol, p_activo: activo }));
    await recargarPerfiles();
  } catch (err) { alert(err.message); pintarPersonal(); }
});

$('tpersonal').addEventListener('click', async e => {
  const b = e.target.closest('button[data-acc=clave]');
  if (!b || !confirm(`¿Restablecer la contraseña a ${CLAVE_INICIAL}?`)) return;
  if (LOCAL) return alert('Vista previa local: no se guardan cambios.');
  try {
    ok(await sb.rpc('pyme_restablecer_clave', { p_id: b.closest('tr').dataset.id, p_password: CLAVE_INICIAL }));
    alert(`Contraseña restablecida a ${CLAVE_INICIAL}. Se le pedirá cambiarla al ingresar.`);
  } catch (err) { alert(err.message); }
});

// ---------- Excel con formato de marca (jefe, gerente, admin) ----------
const XL = { navy: 'FF06255B', verde: 'FF4B9D45', fondo: 'FFF2F4F7', blanco: 'FFFFFFFF', borde: 'FFD9DDE4' };
const FMT = { din: '#,##0.00', ent: '#,##0', mora: '0', pct: '0.0%', fecha: 'dd/mm/yyyy' };

function hojaMarca(wb, nombre, titulo, encabezados, filas, anchos, formatos) {
  const ws = wb.addWorksheet(nombre, { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  const n = encabezados.length;
  ws.mergeCells(1, 1, 1, n); ws.mergeCells(2, 1, 2, n);
  const t = ws.getCell(1, 1);
  t.value = titulo; t.font = { name: 'Arial', size: 16, bold: true, color: { argb: XL.blanco } };
  t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.navy } }; t.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(1).height = 30;
  const f = S.ultima?.fuentes || {};
  const s = ws.getCell(2, 1);
  s.value = `Fecha y hora de generación: ${S.ultima ? fechaHora(S.ultima.generado) : '—'}   ·   ` +
    FUENTES.map(([k, nm]) => `${nm}: ${f[k] ? fecha(f[k]) : '—'}`).join('   ·   ') + '   ·   Uso interno: contiene datos personales';
  s.font = { name: 'Arial', size: 10, bold: true, color: { argb: XL.blanco } };
  s.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.verde } }; s.alignment = { vertical: 'middle', indent: 1 };
  ws.getRow(2).height = 20;
  const h = ws.getRow(4);
  encabezados.forEach((e, i) => {
    const c = h.getCell(i + 1);
    c.value = e; c.font = { name: 'Arial', size: 10, bold: true, color: { argb: XL.blanco } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.verde } };
    c.alignment = { vertical: 'middle', wrapText: true };
  });
  h.height = 30;
  filas.forEach((vals, j) => {
    const row = ws.getRow(5 + j);
    vals.forEach((v, i) => {
      const c = row.getCell(i + 1);
      c.value = v; c.font = { name: 'Arial', size: 10, color: { argb: 'FF333740' } };
      if (formatos[i]) c.numFmt = formatos[i];
      if (j % 2) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.fondo } };
      c.border = { bottom: { style: 'thin', color: { argb: XL.borde } } };
    });
  });
  ws.columns.forEach((c, i) => { c.width = anchos[i]; });
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: n } };
  return ws;
}

async function descargar() {
  const btn = $('btnDescargar');
  btn.disabled = true;
  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Módulo PYME · Instacredit';
    const cs = cols();
    const filas = ordenar(filtrar());
    const valor = (c, r) => {
      const v = r[c.k];
      if (v == null || v === '') return null;
      if (c.tipo === 'fecha') { const [a, m, d] = v.split('-'); return new Date(Date.UTC(+a, m - 1, +d)); }
      return ['din', 'ent', 'pct', 'mora'].includes(c.tipo) ? +v : v;
    };
    hojaMarca(wb, 'Cartera', 'Módulo PYME · Cartera del equipo', cs.map(c => c.t), filas.map(r => cs.map(c => valor(c, r))),
      cs.map(c => c.tipo === 'largo' ? 45 : ['nombre_cliente', 'empresa_genesis', 'promotor'].includes(c.k) ? 32 : c.tipo === 'tel' ? 22 : 15),
      cs.map(c => FMT[c.tipo]));
    const cab = ['Promotor', 'Créditos', 'En mora', '% en mora', 'Monto vencido', 'Total pagado', 'Pagado a capital', 'Saldo pagaré', 'Saldo', '% amortizado'];
    const res = [...resumen(), { promotor: 'Total del equipo', ...totales(S.cartera) }].map(t =>
      [t.promotor, t.n, t.mora, t.n ? t.mora / t.n : null, t.vencido, t.pagado, t.capital, t.pagare, t.saldo, t.pagare ? 1 - t.saldo / t.pagare : null]);
    const wr = hojaMarca(wb, 'Por promotor', 'Módulo PYME · Resumen por promotor', cab, res,
      [36, 11, 11, 12, 16, 16, 16, 16, 16, 13], [null, '#,##0', '#,##0', '0.0%', '#,##0.00', '#,##0.00', '#,##0.00', '#,##0.00', '#,##0.00', '0.0%']);
    wr.getRow(4 + res.length).eachCell(c => {
      c.font = { name: 'Arial', size: 10, bold: true, color: { argb: XL.blanco } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.navy } };
    });
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = `reporte_pyme_${String(S.ultima?.generado || hoyISO()).slice(0, 10)}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) { alert(`No se pudo generar el Excel: ${err.message}`); }
  finally { btn.disabled = false; }
}

// ---------- Botón Actualizar: lo atiende una PC de la red con el proceso de carga encendido ----------
async function equiposConectados() {
  const eq = ok(await sb.from('pyme_equipos').select('*').order('visto_en', { ascending: false }));
  return eq.filter(e => Date.now() - new Date(e.visto_en) < 120000);  // preguntan cada 20 s
}

async function actualizar() {
  if (LOCAL) return cargar();
  const btn = $('btnActualizar');
  btn.disabled = true; btn.textContent = 'Actualizando…';
  try {
    if (!(await equiposConectados()).length) {
      aviso('Ninguna PC de carga está conectada a la red en este momento, así que no se puede actualizar. Se muestran los últimos datos cargados.', true);
      return;
    }
    const id = ok(await sb.rpc('pyme_pedir_actualizacion'));
    const t0 = Date.now();
    for (;;) {
      await new Promise(r => setTimeout(r, 4000));
      const e = ok(await sb.from('pyme_actualizaciones').select('estado,mensaje,equipo').eq('id', id).single());
      if (e.estado === 'ok') { await cargar(); break; }
      if (e.estado === 'error') { aviso(`La actualización falló${veTodo() ? `: ${e.mensaje || ''}` : '; avisale a tu jefe de equipo.'}`, true); break; }
      if (Date.now() - t0 > 180000) {
        aviso('La actualización está tardando más de lo normal: sigue en proceso y los datos se verán al recargar la página.', true);
        break;
      }
    }
  } catch (err) {
    aviso(`No se pudo pedir la actualización: ${err.message}`, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Actualizar';
  }
}

// ---------- Vista ----------
function cambiarTab(tab) {
  S.tab = tab;
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('on', x.dataset.tab === tab));
  pintar();
}

function pintar() {
  $('vistaCartera').hidden = S.tab !== 'cartera';
  $('vistaResumen').hidden = S.tab !== 'resumen';
  $('vistaPersonal').hidden = S.tab !== 'personal';
  if (S.tab === 'resumen') return pintarResumen();
  if (S.tab === 'personal') return pintarPersonal();
  pintarCartera();
}

$('btnClave').addEventListener('click', async () => {
  const actual = prompt('Contraseña actual:');
  if (!actual) return;
  const nueva = prompt('Nueva contraseña (mínimo 8 caracteres). Si usás Tiempos DAC o Auditores, también cambia allá:');
  if (!nueva) return;
  if (nueva.length < 8) return alert('La contraseña debe tener al menos 8 caracteres.');
  if (nueva === CLAVE_INICIAL) return alert('Usá una contraseña distinta de la temporal.');
  try {
    ok(await sb.auth.signInWithPassword({ email: S.perfil.usuario + DOMINIO, password: actual }));
    ok(await sb.auth.updateUser({ password: nueva }));
    alert('Contraseña cambiada.');
  } catch { alert('La contraseña actual no es correcta.'); }
});

$('btnSalir').addEventListener('click', async () => { await sb.auth.signOut(); S.perfil = null; mostrarLogin(); });
$('tabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) cambiarTab(b.dataset.tab); });
$('thead').addEventListener('click', e => {
  const th = e.target.closest('th[data-k]');
  if (!th) return;
  S.orden = { k: th.dataset.k, asc: S.orden.k === th.dataset.k ? !S.orden.asc : true };
  pintarCartera();
});
for (const id of ['fPromotor', 'fSituacion']) $(id).addEventListener('change', pintarCartera);
$('fBuscar').addEventListener('input', pintarCartera);
$('btnDescargar').addEventListener('click', descargar);
$('btnActualizar').addEventListener('click', actualizar);

(async () => {
  try {
    if (LOCAL) {
      // Vista previa: ?local&rol=promotor|jefe|gerente|admin (&cedula=... para un promotor)
      const rol = PARAMS.get('rol') || 'jefe';
      const d = await (await fetch('local/datos.json', { cache: 'no-store' })).json();
      const ced = PARAMS.get('cedula') || d.cartera[0]?.cedula_promotor;
      const cat = d.catalogo.find(c => c.cedula_promotor === ced);
      S.perfil = rol === 'promotor'
        ? { id: 'local', nombre: titulo(cat?.promotor || 'Promotor'), usuario: 'local', rol, cedula_promotor: ced, activo: true }
        : { id: 'local', nombre: 'Vista Previa', usuario: 'local', rol, activo: true };
      return await iniciar();
    }
    S.perfil = await perfilActual();
    if (S.perfil?.activo) await iniciar(); else mostrarLogin();
  } catch (err) {
    mostrarLogin(`No se pudo iniciar: ${err.message}`);
  }
})();
