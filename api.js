/**
 * Poka Yoke · camada de dados SEM Apps Script.
 * O navegador fala direto com:
 *   - BigQuery API  -> roda a query (query.sql)
 *   - Sheets API    -> guarda o resultado (aba Dados Painel), as tratativas (aba Tratados)
 *                      e o controle compartilhado (aba Controle Painel)
 *
 * Só quem clica em "Atualizar" (ou o painel que dispara o auto 5 min) precisa de acesso ao BigQuery.
 * Quem só olha/trata precisa apenas de acesso de edição à planilha.
 */
window.API = (() => {
  const C = window.CONFIG;
  const SCOPES = [
    'https://www.googleapis.com/auth/bigquery',
    'https://www.googleapis.com/auth/spreadsheets',
    'openid', 'email'
  ].join(' ');
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/' + C.SPREADSHEET_ID;
  const BQ = 'https://bigquery.googleapis.com/bigquery/v2/projects/' + C.PROJETO_BQ;
  const LOCK_MAX_MS = 3 * 60 * 1000;     // trava de atualização expira em 3 min
  const CAMPOS_CTL = ['ultimaAtualizacao', 'atualizadoPor', 'versaoDados', 'atualizando', 'ultimoErro', 'autoAtivo', 'autoAlteradoPor'];

  let token = null, expira = 0, client = null, me = '', email = '';

  /* ---------------- login ---------------- */
  function pedirToken(prompt) {
    return new Promise((res, rej) => {
      if (!client) {
        client = google.accounts.oauth2.initTokenClient({
          client_id: C.CLIENT_ID,
          scope: SCOPES,
          hd: C.DOMINIO,
          callback: () => {},
          error_callback: () => {}
        });
      }
      client.callback = r => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        token = r.access_token;
        expira = Date.now() + (Number(r.expires_in || 3600) - 120) * 1000;
        res();
      };
      client.error_callback = e => rej(new Error(e && (e.message || e.type) || 'Login cancelado'));
      client.requestAccessToken({ prompt: prompt });
    });
  }

  async function login() {
    await pedirToken(token ? '' : 'select_account');
    const u = await g('https://www.googleapis.com/oauth2/v3/userinfo');
    email = u.email || '';
    if (C.DOMINIO && !email.toLowerCase().endsWith('@' + C.DOMINIO)) {
      token = null;
      throw new Error('Entre com a conta @' + C.DOMINIO);
    }
    me = email.split('@')[0];
    await garantirAbas();
    return me;
  }

  function logado() { return !!token && Date.now() < expira; }

  /* ---------------- HTTP ---------------- */
  async function g(url, opt) {
    opt = opt || {};
    if (!token) throw new Error('LOGIN');
    if (Date.now() > expira) {
      try { await pedirToken(''); } catch (e) { token = null; throw new Error('LOGIN'); }
    }
    const r = await fetch(url, Object.assign({}, opt, {
      headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, opt.headers || {})
    }));
    if (r.status === 401) { token = null; throw new Error('LOGIN'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (j.error && j.error.message) || r.statusText;
      if (r.status === 403) throw new Error('Sem permissão: ' + msg);
      throw new Error(msg);
    }
    return j;
  }

  /* ---------------- Sheets ---------------- */
  const R = (aba, rg) => "'" + aba.replace(/'/g, "''") + "'!" + rg;
  const enc = encodeURIComponent;

  async function ler(ranges) {
    const j = await g(SHEETS + '/values:batchGet?valueRenderOption=FORMATTED_VALUE&' + ranges.map(r => 'ranges=' + enc(r)).join('&'));
    return (j.valueRanges || []).map(v => v.values || []);
  }
  function gravar(range, values) {
    return g(SHEETS + '/values/' + enc(range) + '?valueInputOption=RAW', { method: 'PUT', body: JSON.stringify({ values: values }) });
  }
  function anexar(range, values) {
    return g(SHEETS + '/values/' + enc(range) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS', { method: 'POST', body: JSON.stringify({ values: values }) });
  }
  function limpar(range) {
    return g(SHEETS + '/values/' + enc(range) + ':clear', { method: 'POST', body: '{}' });
  }

  async function garantirAbas() {
    const j = await g(SHEETS + '?fields=sheets.properties.title');
    const tem = (j.sheets || []).map(s => s.properties.title);
    const faltam = [C.ABA_DADOS, C.ABA_TRATADOS, C.ABA_CONTROLE].filter(t => tem.indexOf(t) < 0);
    if (faltam.length) {
      await g(SHEETS + ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: faltam.map(t => ({ addSheet: { properties: { title: t } } })) }) });
    }
    const [trat] = await ler([R(C.ABA_TRATADOS, 'A1:F1')]);
    if (!trat.length || trat[0][0] !== 'data') {
      await gravar(R(C.ABA_TRATADOS, 'A1:F1'), [['data', 'id_pacote', 'tratado_por', 'hora', 'status', 'observacao']]);
    }
  }

  /* ---------------- controle compartilhado ---------------- */
  function parseCtl(vals) {
    const o = {};
    (vals || []).forEach(r => { if (r[0]) o[r[0]] = r[1] || ''; });
    return o;
  }
  async function lerCtl() { const [v] = await ler([R(C.ABA_CONTROLE, 'A1:B20')]); return parseCtl(v); }
  function gravarCtl(o) { return gravar(R(C.ABA_CONTROLE, 'A1:B' + CAMPOS_CTL.length), CAMPOS_CTL.map(k => [k, o[k] || ''])); }

  function lockDe(ctl) {
    const [quem, ms] = String(ctl.atualizando || '').split('|');
    return (quem && Date.now() - Number(ms) < LOCK_MAX_MS) ? quem : '';
  }
  function meta(ctl) {
    return {
      ultimaAtualizacao: ctl.ultimaAtualizacao || '',
      atualizadoPor: ctl.atualizadoPor || '',
      versaoDados: ctl.versaoDados || '0',
      atualizando: lockDe(ctl),
      ultimoErro: ctl.ultimoErro || '',
      autoAtivo: !!ctl.autoAtivo,
      autoAlteradoPor: ctl.autoAlteradoPor || ''
    };
  }

  /* ---------------- tratativas ---------------- */
  function hoje() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()); }
  function hora() { return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()); }

  function parseTrat(vals) {
    const h = hoje(), out = {};
    (vals || []).slice(1).forEach(r => {
      if (r[0] !== h || !r[1]) return;
      out[String(r[1]).replace(/^'/, '').trim()] = { por: r[2] || '', quando: r[3] || '', status: r[4] || 'tratado', obs: r[5] || '' };
    });
    return out;
  }

  async function salvarTratativa(id, status, obs) {
    id = String(id).trim(); status = String(status || '').trim(); obs = String(obs || '').trim().slice(0, 1000);
    if (!status && obs) status = 'pendente';
    const [vals] = await ler([R(C.ABA_TRATADOS, 'A:F')]);
    const h = hoje();
    let linha = -1;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i][0] === h && String(vals[i][1] || '').replace(/^'/, '').trim() === id) { linha = i + 1; break; }
    }
    const reg = [h, id, me, hora(), status, obs];
    if (!status && !obs) { if (linha > 0) await limpar(R(C.ABA_TRATADOS, 'A' + linha + ':F' + linha)); }
    else if (linha > 0) await gravar(R(C.ABA_TRATADOS, 'A' + linha + ':F' + linha), [reg]);
    else await anexar(R(C.ABA_TRATADOS, 'A:F'), [reg]);
    const [v2] = await ler([R(C.ABA_TRATADOS, 'A:F')]);
    return parseTrat(v2);
  }

  /* ---------------- leitura ---------------- */
  async function getData() {
    const [dados, trat, ctl] = await ler([R(C.ABA_DADOS, 'A:Z'), R(C.ABA_TRATADOS, 'A:F'), R(C.ABA_CONTROLE, 'A1:B20')]);
    let rows = [];
    if (dados.length > 1) {
      const head = dados[0].map(h => String(h).trim().toLowerCase().replace(/\s+/g, '_'));
      const iId = head.indexOf('id_pacote');
      rows = dados.slice(1).filter(r => r[iId]).map(r => {
        const o = {}; head.forEach((h, i) => (o[h] = String(r[i] == null ? '' : r[i]).trim())); return o;
      });
    }
    return { rows: rows, tratados: parseTrat(trat), meta: meta(parseCtl(ctl)), me: me };
  }

  async function getEstado() {
    const [trat, ctl] = await ler([R(C.ABA_TRATADOS, 'A:F'), R(C.ABA_CONTROLE, 'A1:B20')]);
    return { tratados: parseTrat(trat), meta: meta(parseCtl(ctl)) };
  }

  /* ---------------- BigQuery ---------------- */
  async function rodarQuery(sql) {
    let r = await g(BQ + '/queries', { method: 'POST', body: JSON.stringify({
      query: sql, useLegacySql: false, timeoutMs: 60000, maxResults: 10000, location: 'US',
      labels: { origem: 'painel_pokayoke_web' }
    }) });
    const job = r.jobReference.jobId, loc = r.jobReference.location;
    const url = (extra) => BQ + '/queries/' + job + '?location=' + enc(loc) + '&maxResults=10000&timeoutMs=30000' + (extra || '');
    while (!r.jobComplete) { await new Promise(s => setTimeout(s, 1500)); r = await g(url()); }
    const cab = r.schema.fields.map(f => f.name), linhas = [];
    const add = rows => (rows || []).forEach(x => linhas.push(x.f.map(c => (c.v == null ? '' : String(c.v)))));
    add(r.rows);
    let tok = r.pageToken;
    while (tok) { const p = await g(url('&pageToken=' + enc(tok))); add(p.rows); tok = p.pageToken; }
    return { cab: cab, linhas: linhas };
  }

  async function atualizarQuery(opts) {
    opts = opts || {};
    const quem = opts.quem || me, intervalo = opts.intervaloSeg == null ? 30 : opts.intervaloSeg;
    let ctl = await lerCtl();
    const travado = lockDe(ctl);
    if (travado && travado !== quem) return { ok: false, msg: travado + ' já está atualizando. Em instantes os dados aparecem.', meta: meta(ctl) };
    if (ctl.ultimaAtualizacao && Date.now() - new Date(ctl.ultimaAtualizacao).getTime() < intervalo * 1000) {
      return { ok: true, msg: 'Acabou de ser atualizado.', meta: meta(ctl), pulou: true };
    }

    // pega a trava e confirma que ninguém pegou junto
    const minha = me + '|' + Date.now();
    ctl.atualizando = minha; await gravarCtl(ctl);
    await new Promise(s => setTimeout(s, 1500));
    ctl = await lerCtl();
    if (ctl.atualizando !== minha) return { ok: false, msg: 'Outra pessoa começou a atualizar junto. Aguarde.', meta: meta(ctl) };

    try {
      const sql = await fetch('query.sql', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('query.sql não encontrado'); return r.text(); });
      const res = await rodarQuery(sql);

      // nome do rep pela aba User/Name
      const [nomes] = await ler([R(C.ABA_NOMES, 'A:B')]);
      const mapa = {}; (nomes || []).slice(1).forEach(n => { if (n[0]) mapa[String(n[0]).trim().toLowerCase()] = n[1] || ''; });
      const iU = res.cab.indexOf('usuario');
      const tabela = [res.cab.concat(['nome rep'])].concat(res.linhas.map(l => l.concat([iU >= 0 ? (mapa[String(l[iU]).toLowerCase()] || '') : ''])));

      await limpar(R(C.ABA_DADOS, 'A:Z'));
      await gravar(R(C.ABA_DADOS, 'A1'), tabela);

      ctl.ultimaAtualizacao = new Date().toISOString();
      ctl.atualizadoPor = opts.auto ? 'automático' : quem;
      ctl.versaoDados = String(Date.now());
      ctl.atualizando = ''; ctl.ultimoErro = '';
      await gravarCtl(ctl);
      return { ok: true, msg: 'Dados atualizados (' + res.linhas.length + ' erros).', meta: meta(ctl) };
    } catch (e) {
      if (e.message === 'LOGIN') throw e;
      ctl.atualizando = ''; ctl.ultimoErro = new Date().toISOString() + ' · ' + me + ': ' + e.message;
      try { await gravarCtl(ctl); } catch (_) {}
      return { ok: false, msg: 'Erro ao atualizar: ' + e.message, meta: meta(ctl) };
    }
  }

  /** Chamado a cada 30 s pelo painel: se o auto estiver ligado e os dados velhos, este PC atualiza. */
  async function autoTick() {
    const ctl = await lerCtl();
    if (!ctl.autoAtivo || lockDe(ctl)) return null;
    const idade = ctl.ultimaAtualizacao ? Date.now() - new Date(ctl.ultimaAtualizacao).getTime() : Infinity;
    if (idade < C.AUTO_MINUTOS * 60 * 1000) return null;
    // espalha um pouco para vários PCs não tentarem no mesmo segundo
    await new Promise(s => setTimeout(s, Math.random() * 4000));
    return atualizarQuery({ auto: true, intervaloSeg: (C.AUTO_MINUTOS * 60) - 20 });
  }

  async function setAutoAtualizacao(ligar) {
    const ctl = await lerCtl();
    ctl.autoAtivo = ligar ? '1' : ''; ctl.autoAlteradoPor = me;
    await gravarCtl(ctl);
    return meta(ctl);
  }

  return {
    login: login, logado: logado, eu: () => me,
    getData: getData, getEstado: getEstado,
    atualizarQuery: () => atualizarQuery({}),
    salvarTratativa: salvarTratativa,
    setAutoAtualizacao: setAutoAtualizacao,
    autoTick: autoTick
  };
})();
