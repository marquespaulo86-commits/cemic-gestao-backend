// ═══════════════════════════════════════════════════════
// LENGLISH — Backend v2.0
// Node.js + Express + PostgreSQL + Resend (OTP)
// Deploy: Railway (lenglish-server)
// ═══════════════════════════════════════════════════════

const express    = require('express');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const { Resend } = require('resend');

const app    = express();
app.set('trust proxy', 1);
const PORT   = process.env.PORT || 3000;
const resend = new Resend(process.env.RESEND_API_KEY);

// ── DB ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
});

// ── MIDDLEWARE ───────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: function(origin, callback) {
    // Permitir requisições sem origin (Postman, curl, etc.)
    if (!origin) return callback(null, true);
    const allowed = [
      'https://lenglish.com.br',
      'https://www.lenglish.com.br',
      'http://localhost:3000',
      'http://localhost:5500',
    ];
    if (allowed.includes(origin) || /\.netlify\.app$/.test(origin)) {
      return callback(null, true);
    }
    // Permitir qualquer subpath do domínio lenglish
    if (/^https?:\/\/(www\.)?lenglish\.com\.br/.test(origin)) {
      return callback(null, true);
    }
    return callback(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Muitas tentativas. Tente novamente em 15 minutos.' },
});

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: { error: 'Muitos envios de código. Aguarde 10 minutos.' },
});

// ── AUTH MIDDLEWARE ──────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Token não fornecido.' });
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

function masterMiddleware(req, res, next) {
  const token = req.headers['x-master-token'] || req.headers['authorization']?.replace('Bearer ','');
  const masterToken = process.env.MASTER_TOKEN;
  console.log('[MASTER] token recebido:', token ? token.substring(0,8)+'...' : 'NENHUM');
  console.log('[MASTER] MASTER_TOKEN configurado:', masterToken ? 'SIM' : 'NÃO');
  if (!masterToken) {
    return res.status(500).json({ error: 'MASTER_TOKEN não configurado no servidor.' });
  }
  if (token !== masterToken) {
    return res.status(403).json({ error: 'Acesso negado. Token inválido.' });
  }
  next();
}

// ── HEALTH CHECK ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', app: 'Lenglish API', version: '2.0' });
});

// ═══════════════════════════════════════════════════════
// OTP — CONFIRMAÇÃO DE EMAIL
// ═══════════════════════════════════════════════════════

// Gera código OTP numérico de 6 dígitos
function gerarOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// POST /auth/enviar-codigo
// Gera e envia um OTP de 6 dígitos para o email informado
app.post('/auth/enviar-codigo', otpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }

  // Verificar se email já está cadastrado
  const existe = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
  if (existe.rows.length > 0) {
    return res.status(409).json({ error: 'Este e-mail já está cadastrado. Faça login.' });
  }

  const codigo = gerarOTP();
  const expira = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos

  // Salvar OTP temporário na tabela otp_pendentes
  await pool.query(
    `INSERT INTO otp_pendentes (email, codigo, expira_em)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET codigo = $2, expira_em = $3, tentativas = 0`,
    [email, codigo, expira]
  );

  // Enviar email via Resend
  console.log(`[OTP] Enviando código para: ${email} | FROM: ${process.env.RESEND_FROM_EMAIL}`);
  try {
    const sendResult = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'noreply@lenglish.com.br',
      to: email,
      subject: `${codigo} — Código de confirmação Lenglish`,
      html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
  body { font-family: 'Helvetica Neue', Arial, sans-serif; background: #F7F6F2; margin: 0; padding: 0; }
  .wrap { max-width: 480px; margin: 40px auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
  .hd { background: linear-gradient(135deg, #0F2D5E 0%, #1A3A6E 100%); padding: 32px; text-align: center; }
  .logo { font-size: 36px; font-weight: 900; color: #fff; letter-spacing: -1px; }
  .logo em { color: #C8942A; font-style: normal; }
  .body { padding: 32px; text-align: center; }
  .otp { font-size: 48px; font-weight: 900; letter-spacing: 12px; color: #0F2D5E; background: #F0F4FA; border-radius: 12px; padding: 18px 24px; display: inline-block; margin: 20px 0; font-family: monospace; }
  .note { font-size: 13px; color: #78766E; line-height: 1.65; margin-top: 12px; }
  .ft { background: #F7F6F2; padding: 18px; text-align: center; font-size: 11px; color: #B0AEA6; }
</style>
</head>
<body>
<div class="wrap">
  <div class="hd"><div class="logo">Leng<em>lish</em></div></div>
  <div class="body">
    <p style="font-size:16px;font-weight:700;color:#0F2D5E;margin-bottom:4px">Confirme seu cadastro</p>
    <p style="font-size:14px;color:#78766E">Use este código para verificar seu e-mail:</p>
    <div class="otp">${codigo}</div>
    <div class="note">
      Este código é válido por <strong>10 minutos</strong>.<br>
      Se você não solicitou este cadastro, ignore este e-mail.
    </div>
  </div>
  <div class="ft">
    Centro Maranhense de Idiomas e Culturas · São Luís, MA<br>
    lenglish.com.br
  </div>
</div>
</body>
</html>`,
    });
    console.log('[OTP] Resend resultado:', JSON.stringify(sendResult));
    res.json({ ok: true, message: 'Código enviado.' });
  } catch (err) {
    console.error('[OTP] Erro Resend completo:', JSON.stringify(err), err.message);
    res.status(500).json({ error: 'Erro ao enviar e-mail. Verifique o endereço e tente novamente.' });
  }
});

// ═══════════════════════════════════════════════════════
// AUTH — CADASTRO E LOGIN
// ═══════════════════════════════════════════════════════

// Gera código único de aluno (LG-XXXX-XXXX)
function gerarCodigo() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'LG-';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// POST /auth/registro — agora exige codigo_confirmacao (OTP)
app.post('/auth/registro', async (req, res) => {
  const { nome, sobrenome, email, senha, data_nascimento,
          instituicao, nivel, foto, whatsapp, codigo_confirmacao } = req.body;

  if (!nome || !sobrenome || !senha || senha.length < 6) {
    return res.status(400).json({ error: 'Nome, sobrenome e senha (mín. 6 caracteres) são obrigatórios.' });
  }
  if (!email) {
    return res.status(400).json({ error: 'E-mail obrigatório.' });
  }
  if (!codigo_confirmacao || codigo_confirmacao.length !== 6) {
    return res.status(400).json({ error: 'Código de confirmação de 6 dígitos é obrigatório.' });
  }

  // Validar OTP
  const otpResult = await pool.query(
    `SELECT codigo, expira_em, tentativas FROM otp_pendentes WHERE email = $1`,
    [email]
  );

  if (otpResult.rows.length === 0) {
    return res.status(400).json({ error: 'Nenhum código encontrado para este e-mail. Solicite um novo.' });
  }

  const otp = otpResult.rows[0];
  if (new Date() > new Date(otp.expira_em)) {
    await pool.query('DELETE FROM otp_pendentes WHERE email = $1', [email]);
    return res.status(400).json({ error: 'Código expirado. Solicite um novo código.' });
  }
  if (otp.tentativas >= 5) {
    return res.status(400).json({ error: 'Muitas tentativas incorretas. Solicite um novo código.' });
  }
  if (otp.codigo !== codigo_confirmacao) {
    await pool.query(
      'UPDATE otp_pendentes SET tentativas = tentativas + 1 WHERE email = $1', [email]
    );
    return res.status(400).json({ error: 'Código incorreto. Verifique e tente novamente.' });
  }

  // OTP válido — limpar OTP e criar conta
  await pool.query('DELETE FROM otp_pendentes WHERE email = $1', [email]);

  // Validar idade mínima
  if (data_nascimento) {
    const idade = Math.floor((Date.now() - new Date(data_nascimento)) / (365.25 * 86400000));
    if (idade < 12) return res.status(400).json({ error: 'Idade mínima: 12 anos.' });
  }

  // Verificar email duplicado
  const existe = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
  if (existe.rows.length > 0) {
    return res.status(409).json({ error: 'E-mail já cadastrado.' });
  }

  try {
    const senhaHash = await bcrypt.hash(senha, 10);
    const codigo    = gerarCodigo();
    const fotoUrl   = foto || null;

    const result = await pool.query(
      `INSERT INTO usuarios
         (nome, sobrenome, email, senha_hash, data_nascimento, instituicao,
          nivel, codigo, foto_url, whatsapp, email_confirmado, data_inicio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,NOW())
       RETURNING id, nome, sobrenome, codigo, nivel`,
      [nome, sobrenome, email, senhaHash,
       data_nascimento || null,
       instituicao || 'Centro Maranhense de Idiomas e Culturas',
       nivel || 'basic', codigo, fotoUrl, whatsapp || null]
    );

    const usuario = result.rows[0];
    await inicializarProgresso(usuario.id);
    // Atualizar ultimo_acesso
    pool.query('UPDATE usuarios SET ultimo_acesso = NOW() WHERE id = $1', [usuario.id]).catch(()=>{});
    const token = jwt.sign({ id: usuario.id, codigo: usuario.codigo }, process.env.JWT_SECRET, { expiresIn: '30d' });

    // Email de boas-vindas
    resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'noreply@lenglish.com.br',
      to: email,
      subject: 'Bem-vindo à Lenglish! 🎓',
      html: `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
  <h1 style="color:#0F2D5E;font-size:28px;margin-bottom:4px">Leng<span style="color:#C8942A">lish</span></h1>
  <p style="color:#78766E;font-size:13px;margin-bottom:24px">Centro Maranhense de Idiomas e Culturas</p>
  <p style="font-size:15px;color:#1C1C1A">Olá, <strong>${nome}</strong>! Seu cadastro foi confirmado com sucesso.</p>
  <p style="font-size:14px;color:#78766E">Seu código de aluno:</p>
  <div style="font-size:22px;font-weight:900;letter-spacing:4px;color:#0F2D5E;background:#F0F4FA;border-radius:8px;padding:12px 20px;display:inline-block;font-family:monospace">${codigo}</div>
  <p style="font-size:13px;color:#78766E;margin-top:16px">Guarde este código — você precisará dele para acessar a plataforma.</p>
  <p style="font-size:13px;color:#78766E">Bons estudos! 🚀</p>
</div>`,
    }).catch(err => console.error('Erro email boas-vindas:', err));

    res.status(201).json({ token, usuario });
  } catch (err) {
    console.error('Erro no cadastro:', err);
    res.status(500).json({ error: 'Erro interno ao criar conta.' });
  }
});

// POST /auth/login
app.post('/auth/login', loginLimiter, async (req, res) => {
  const { codigo, senha } = req.body;
  if (!codigo || !senha) return res.status(400).json({ error: 'Código e senha são obrigatórios.' });

  try {
    const result = await pool.query(
      'SELECT * FROM usuarios WHERE codigo = $1',
      [codigo.toUpperCase()]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Código ou senha incorretos.' });

    const usuario = result.rows[0];
    const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaOk) return res.status(401).json({ error: 'Código ou senha incorretos.' });

    // Verificar status de aprovação
    if (usuario.status_cadastro === 'pendente') {
      return res.status(403).json({
        error: 'Seu cadastro ainda está aguardando aprovação do professor. Você receberá um e-mail quando for aprovado.',
        status: 'pendente'
      });
    }
    if (usuario.status_cadastro === 'rejeitado') {
      return res.status(403).json({
        error: 'Seu cadastro foi recusado. Entre em contato com a instituição para mais informações.',
        status: 'rejeitado'
      });
    }

    // Atualizar ultimo_acesso
    pool.query('UPDATE usuarios SET ultimo_acesso = NOW() WHERE id = $1', [usuario.id]).catch(()=>{});
    const token = jwt.sign({ id: usuario.id, codigo: usuario.codigo }, process.env.JWT_SECRET, { expiresIn: '30d' });

    res.json({
      token,
      usuario: {
        id:           usuario.id,
        nome:         usuario.nome,
        sobrenome:    usuario.sobrenome,
        email:        usuario.email,
        codigo:       usuario.codigo,
        nivel:        usuario.nivel,
        instituicao:  usuario.instituicao,
        foto_url:     usuario.foto_url,
        data_inicio:  usuario.data_inicio,
      }
    });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: 'Erro interno.' });
  }
});


// ═══════════════════════════════════════════════════════
// PERFIL
// ═══════════════════════════════════════════════════════

// GET /perfil
app.get('/perfil', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, sobrenome, email, codigo, nivel, instituicao, foto_url, data_inicio
       FROM usuarios WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// PATCH /perfil
app.patch('/perfil', authMiddleware, async (req, res) => {
  const { nome, sobrenome, foto_url, instituicao } = req.body;
  try {
    await pool.query(
      `UPDATE usuarios SET
         nome        = COALESCE($1, nome),
         sobrenome   = COALESCE($2, sobrenome),
         foto_url    = COALESCE($3, foto_url),
         instituicao = COALESCE($4, instituicao)
       WHERE id = $5`,
      [nome, sobrenome, foto_url, instituicao, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao atualizar perfil.' });
  }
});

// PATCH /perfil/senha
app.patch('/perfil/senha', authMiddleware, async (req, res) => {
  const { senha_atual, senha_nova } = req.body;
  if (!senha_atual || !senha_nova || senha_nova.length < 6) {
    return res.status(400).json({ error: 'Senha nova deve ter mínimo 6 caracteres.' });
  }
  try {
    const result = await pool.query('SELECT senha_hash FROM usuarios WHERE id = $1', [req.user.id]);
    const ok = await bcrypt.compare(senha_atual, result.rows[0].senha_hash);
    if (!ok) return res.status(401).json({ error: 'Senha atual incorreta.' });
    const novaHash = await bcrypt.hash(senha_nova, 10);
    await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [novaHash, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao alterar senha.' });
  }
});

// ═══════════════════════════════════════════════════════
// PROGRESSO — SEMANAS E HABILIDADES
// ═══════════════════════════════════════════════════════

// GET /progresso — retorna todo o progresso do aluno
app.get('/progresso', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT semana, habilidade, concluido, concluido_em
       FROM progresso
       WHERE usuario_id = $1
       ORDER BY semana, habilidade`,
      [req.user.id]
    );

    // Buscar data de início do aluno
    const user = await pool.query('SELECT data_inicio, nivel FROM usuarios WHERE id = $1', [req.user.id]);
    const { data_inicio, nivel } = user.rows[0];

    res.json({
      data_inicio,
      nivel,
      progresso: result.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar progresso.' });
  }
});

// POST /progresso/concluir — marca uma habilidade como concluída
app.post('/progresso/concluir', authMiddleware, async (req, res) => {
  const { semana, habilidade } = req.body;
  const habilidades = ['listening', 'reading', 'speaking', 'writing'];

  if (semana < 0 || semana > 15 || !habilidades.includes(habilidade)) {
    return res.status(400).json({ error: 'Semana (0-15) ou habilidade inválida.' });
  }

  try {
    // Verificar se a semana está desbloqueada
    const desbloqueada = await semanaDesbloqueada(req.user.id, semana);
    if (!desbloqueada) {
      return res.status(403).json({ error: 'Semana bloqueada. Conclua a semana anterior primeiro.' });
    }

    await pool.query(
      `UPDATE progresso SET concluido = true, concluido_em = NOW()
       WHERE usuario_id = $1 AND semana = $2 AND habilidade = $3`,
      [req.user.id, semana, habilidade]
    );

    // Verificar se a semana inteira foi concluída
    const semanaOk = await semanaConcluida(req.user.id, semana);

    res.json({ ok: true, semana_concluida: semanaOk });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar progresso.' });
  }
});

// POST /progresso/passo — salva o passo atual dentro de uma habilidade
app.post('/progresso/passo', authMiddleware, async (req, res) => {
  const { semana, habilidade, passo, respostas } = req.body;
  try {
    await pool.query(
      `INSERT INTO progresso_detalhe (usuario_id, semana, habilidade, passo, respostas, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (usuario_id, semana, habilidade)
       DO UPDATE SET passo = $4, respostas = $5, atualizado_em = NOW()`,
      [req.user.id, semana, habilidade, passo, JSON.stringify(respostas || {})]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao salvar passo.' });
  }
});

// GET /progresso/passo/:semana/:habilidade — recupera passo salvo
app.get('/progresso/passo/:semana/:habilidade', authMiddleware, async (req, res) => {
  const { semana, habilidade } = req.params;
  try {
    const result = await pool.query(
      `SELECT passo, respostas FROM progresso_detalhe
       WHERE usuario_id = $1 AND semana = $2 AND habilidade = $3`,
      [req.user.id, parseInt(semana), habilidade]
    );
    if (result.rows.length === 0) return res.json({ passo: 0, respostas: {} });
    const row = result.rows[0];
    res.json({ passo: row.passo, respostas: row.respostas });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar passo.' });
  }
});

// ═══════════════════════════════════════════════════════
// PAINEL MASTER
// ═══════════════════════════════════════════════════════

// GET /master/alunos
app.get('/master/alunos', masterMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id, u.nome, u.sobrenome, u.email, u.codigo, u.nivel,
         u.instituicao, u.data_inicio,
         COUNT(p.id) FILTER (WHERE p.concluido = true) AS habilidades_concluidas,
         (SELECT COUNT(*) FROM progresso WHERE usuario_id = u.id) AS total_habilidades
       FROM usuarios u
       LEFT JOIN progresso p ON p.usuario_id = u.id
       GROUP BY u.id
       ORDER BY u.data_inicio DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar alunos.' });
  }
});

// GET /master/aluno/:id
app.get('/master/aluno/:id', masterMiddleware, async (req, res) => {
  try {
    const usuario = await pool.query(
      'SELECT id, nome, sobrenome, email, codigo, nivel, instituicao, data_inicio, foto_url FROM usuarios WHERE id = $1',
      [req.params.id]
    );
    if (usuario.rows.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

    const progresso = await pool.query(
      `SELECT semana, habilidade, concluido, concluido_em
       FROM progresso WHERE usuario_id = $1 ORDER BY semana, habilidade`,
      [req.params.id]
    );

    // Estatísticas agregadas por semana
    const semanas = {};
    progresso.rows.forEach(p => {
      if (!semanas[p.semana]) semanas[p.semana] = { concluidas: 0, total: 0, habilidades: {} };
      semanas[p.semana].total++;
      semanas[p.semana].habilidades[p.habilidade] = {
        concluido: p.concluido,
        concluido_em: p.concluido_em
      };
      if (p.concluido) semanas[p.semana].concluidas++;
    });

    const total_concluidas = progresso.rows.filter(p => p.concluido).length;
    const semanas_completas = Object.values(semanas).filter(s => s.concluidas === 4).length;

    res.json({
      usuario: usuario.rows[0],
      progresso: progresso.rows,
      stats: {
        total_habilidades: progresso.rows.length,
        total_concluidas,
        semanas_completas,
        percentual: Math.round(semanas_completas / 16 * 100)
      },
      semanas
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar aluno.' });
  }
});

// GET /master/stats
app.get('/master/stats', masterMiddleware, async (req, res) => {
  try {
    const [total, porNivel, concluidos] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM usuarios'),
      pool.query('SELECT nivel, COUNT(*) FROM usuarios GROUP BY nivel'),
      pool.query(`SELECT COUNT(DISTINCT usuario_id) FROM progresso
                  WHERE semana = 15 AND habilidade = 'writing' AND concluido = true`),
    ]);
    res.json({
      total_alunos:    parseInt(total.rows[0].count),
      por_nivel:       porNivel.rows,
      cursos_concluidos: parseInt(concluidos.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar estatísticas.' });
  }
});

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

function gerarCodigo() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'LG-';
  for (let i = 0; i < 8; i++) {
    if (i === 4) code += '-';
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code; // ex: LG-ABCD-EFGH
}

async function inicializarProgresso(usuarioId) {
  const habilidades = ['listening', 'reading', 'speaking', 'writing'];
  const valores = [];
  const params = [];
  let idx = 1;
  for (let s = 0; s < 16; s++) {
    for (const h of habilidades) {
      valores.push(`($${idx++}, $${idx++}, $${idx++})`);
      params.push(usuarioId, s, h);
    }
  }
  await pool.query(
    `INSERT INTO progresso (usuario_id, semana, habilidade) VALUES ${valores.join(',')}
     ON CONFLICT DO NOTHING`,
    params
  );
}

async function semanaConcluida(usuarioId, semana) {
  const result = await pool.query(
    `SELECT COUNT(*) FROM progresso
     WHERE usuario_id = $1 AND semana = $2 AND concluido = true`,
    [usuarioId, semana]
  );
  return parseInt(result.rows[0].count) === 4;
}

async function semanaDesbloqueada(usuarioId, semana) {
  if (semana === 0) return true;

  // Verificar data
  const user = await pool.query('SELECT data_inicio FROM usuarios WHERE id = $1', [usuarioId]);
  const inicio = new Date(user.rows[0].data_inicio);
  const dataLiberacao = new Date(inicio.getTime() + semana * 7 * 24 * 3600 * 1000);
  if (new Date() < dataLiberacao) return false;

  // Verificar semana anterior concluída
  return await semanaConcluida(usuarioId, semana - 1);
}

// ── INICIALIZAR BANCO ────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id              SERIAL PRIMARY KEY,
      nome            TEXT NOT NULL,
      sobrenome       TEXT NOT NULL,
      email           TEXT UNIQUE,
      senha_hash      TEXT NOT NULL,
      codigo          TEXT UNIQUE NOT NULL,
      nivel           TEXT NOT NULL DEFAULT 'basic',
      instituicao     TEXT,
      foto_url        TEXT,
      data_nascimento DATE,
      data_inicio     TIMESTAMP DEFAULT NOW(),
      criado_em       TIMESTAMP DEFAULT NOW(),
      whatsapp        TEXT,
      email_confirmado BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS otp_pendentes (
      email       TEXT PRIMARY KEY,
      codigo      TEXT NOT NULL,
      expira_em   TIMESTAMP NOT NULL,
      tentativas  INTEGER DEFAULT 0,
      criado_em   TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS progresso (
      id          SERIAL PRIMARY KEY,
      usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      semana      INTEGER NOT NULL CHECK (semana >= 0 AND semana <= 15),
      habilidade  TEXT NOT NULL CHECK (habilidade IN ('listening','reading','speaking','writing')),
      concluido   BOOLEAN DEFAULT FALSE,
      concluido_em TIMESTAMP,
      UNIQUE (usuario_id, semana, habilidade)
    );

    CREATE TABLE IF NOT EXISTS progresso_detalhe (
      id          SERIAL PRIMARY KEY,
      usuario_id  INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      semana      INTEGER NOT NULL,
      habilidade  TEXT NOT NULL,
      passo       INTEGER DEFAULT 0,
      respostas   JSONB DEFAULT '{}',
      atualizado_em TIMESTAMP DEFAULT NOW(),
      UNIQUE (usuario_id, semana, habilidade)
    );

    CREATE INDEX IF NOT EXISTS idx_progresso_usuario ON progresso(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_detalhe_usuario ON progresso_detalhe(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_usuarios_codigo ON usuarios(codigo);
    CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_pendentes(email);

    -- Adicionar status_cadastro se não existir
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='usuarios' AND column_name='status_cadastro') THEN
        ALTER TABLE usuarios ADD COLUMN status_cadastro TEXT DEFAULT 'pendente'
          CHECK (status_cadastro IN ('pendente','aprovado','rejeitado'));
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS sessoes (
      id           SERIAL PRIMARY KEY,
      usuario_id   INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      ultimo_acesso TIMESTAMP DEFAULT NOW(),
      dispositivo  TEXT,
      UNIQUE(usuario_id)
    );

    CREATE TABLE IF NOT EXISTS mensagens (
      id              SERIAL PRIMARY KEY,
      usuario_id      INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
      remetente_id    INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      remetente_tipo  TEXT NOT NULL CHECK (remetente_tipo IN ('aluno','professor')),
      conteudo        TEXT NOT NULL,
      lida            BOOLEAN DEFAULT FALSE,
      criado_em       TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_mensagens_usuario ON mensagens(usuario_id);
    CREATE INDEX IF NOT EXISTS idx_mensagens_nao_lidas ON mensagens(usuario_id, remetente_tipo, lida);

    -- Adicionar ultimo_acesso em usuarios se não existir
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='usuarios' AND column_name='ultimo_acesso') THEN
        ALTER TABLE usuarios ADD COLUMN ultimo_acesso TIMESTAMP;
      END IF;
    END $$;
    -- Adicionar colunas novas se não existirem (migração segura)
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='usuarios' AND column_name='whatsapp') THEN
        ALTER TABLE usuarios ADD COLUMN whatsapp TEXT;
      END IF;
    END $$;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name='usuarios' AND column_name='email_confirmado') THEN
        ALTER TABLE usuarios ADD COLUMN email_confirmado BOOLEAN DEFAULT FALSE;
      END IF;
    END $$;

  `);
  console.log('✅ Banco de dados inicializado.');
}

// ── START ────────────────────────────────────────────
// Iniciar servidor imediatamente — initDB em background
app.listen(PORT, () => {
  console.log('🚀 Lenglish API rodando na porta ' + PORT);
});

// Inicializar banco em background (não bloqueia o servidor)
initDB().then(() => {

// GET /master/criar-teste — cria usuário de teste com status aprovado
app.get('/master/criar-teste', masterMiddleware, async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const senhaHash = await bcrypt.hash('3040@86', 10);
    
    // Verificar se já existe
    const existe = await pool.query(
      'SELECT id, codigo FROM usuarios WHERE email = $1',
      ['marquespaulo86@gmail.com']
    );
    
    if (existe.rows.length > 0) {
      // Atualizar status para aprovado e senha
      await pool.query(
        `UPDATE usuarios SET 
           senha_hash = $1,
           status_cadastro = 'aprovado',
           nivel = 'basic'
         WHERE email = $2`,
        [senhaHash, 'marquespaulo86@gmail.com']
      );
      return res.json({ 
        ok: true, 
        action: 'updated',
        codigo: existe.rows[0].codigo,
        email: 'marquespaulo86@gmail.com',
        senha: '3040@86'
      });
    }
    
    // Criar novo
    function gerarCodigo() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = 'LG-';
      for (let i = 0; i < 8; i++) {
        if (i === 4) code += '-';
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      return code;
    }
    const codigo = gerarCodigo();
    
    const result = await pool.query(
      `INSERT INTO usuarios 
         (nome, sobrenome, email, senha_hash, codigo, nivel, 
          instituicao, status_cadastro, email_confirmado, data_inicio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'aprovado',true,NOW())
       RETURNING id, codigo`,
      ['Paulo', 'Marques', 'marquespaulo86@gmail.com', 
       senhaHash, codigo, 'basic',
       'Centro Maranhense de Idiomas e Culturas - CEMIC']
    );
    
    const usuario = result.rows[0];
    
    // Inicializar progresso
    const habilidades = ['listening','reading','speaking','writing'];
    const valores = [];
    const params = [];
    let idx = 1;
    for (let s = 0; s < 16; s++) {
      for (const h of habilidades) {
        valores.push(`($${idx++},$${idx++},$${idx++})`);
        params.push(usuario.id, s, h);
      }
    }
    await pool.query(
      `INSERT INTO progresso (usuario_id,semana,habilidade) 
       VALUES ${valores.join(',')} ON CONFLICT DO NOTHING`,
      params
    );
    
    res.json({ 
      ok: true, 
      action: 'created',
      codigo: usuario.codigo,
      email: 'marquespaulo86@gmail.com',
      senha: '3040@86'
    });
  } catch (err) {
    console.error('Erro criar teste:', err);
    res.status(500).json({ error: err.message });
  }
});


// DELETE /master/reset-progresso/:email — zera progresso de um usuário
app.delete('/master/reset-progresso/:email', masterMiddleware, async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    // Buscar usuário
    const user = await pool.query(
      'SELECT id, nome, codigo FROM usuarios WHERE email = $1',
      [email]
    );
    if(user.rows.length === 0){
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    const u = user.rows[0];
    // Zerar progresso
    await pool.query(
      'UPDATE progresso SET concluido = false, concluido_em = NULL WHERE usuario_id = $1',
      [u.id]
    );
    // Zerar progresso detalhe
    await pool.query(
      'DELETE FROM progresso_detalhe WHERE usuario_id = $1',
      [u.id]
    );
    res.json({ ok: true, message: `Progresso de ${u.nome} (${u.codigo}) zerado com sucesso.` });
  } catch(err) {
    console.error('Erro reset progresso:', err);
    res.status(500).json({ error: err.message });
  }
});


// POST /dict — dicionário bilíngue inglês-português via OpenAI
app.post('/dict', authMiddleware, (req, res) => {
  const { word } = req.body;
  if (!word || !word.trim()) return res.status(400).json({ error: 'Palavra obrigatória.' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'API não configurada.' });

  const https = require('https');
  const w = word.trim();
  const prompt = 'You are a bilingual EN-PT dictionary for Brazilian students. For the English word "' + w + '" reply ONLY with this JSON and nothing else: {"word":"' + w + '","phonetic":"IPA pronunciation","translation":"traducao em portugues","example":"example sentence in English","example_pt":"traducao do exemplo em portugues"}';

  const bodyData = JSON.stringify({
    model: 'gpt-4o-mini',
    max_tokens: 300,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }]
  });

  const options = {
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
      'Content-Length': Buffer.byteLength(bodyData)
    },
    timeout: 15000
  };

  const chunks = [];
  const req2 = https.request(options, (r2) => {
    r2.on('data', c => chunks.push(c));
    r2.on('end', () => {
      try {
        const raw = JSON.parse(Buffer.concat(chunks).toString());
        const txt = (raw.choices && raw.choices[0] && raw.choices[0].message && raw.choices[0].message.content) || '';
        console.log('[DICT] resposta OpenAI:', txt.substring(0, 100));
        let entry;
        try { entry = JSON.parse(txt.trim()); }
        catch(_) {
          const m = txt.match(/\{[\s\S]+\}/);
          if (m) { entry = JSON.parse(m[0]); }
          else { throw new Error('no json: ' + txt.substring(0, 80)); }
        }
        res.json(entry);
      } catch(e) {
        console.error('[DICT] parse:', e.message);
        res.status(500).json({ error: 'Erro ao processar.' });
      }
    });
  });
  req2.on('error', e => { console.error('[DICT] net:', e.message); res.status(500).json({ error: 'Erro de rede.' }); });
  req2.on('timeout', () => { req2.destroy(); res.status(504).json({ error: 'Timeout.' }); });
  req2.write(bodyData);
  req2.end();
});


// GET /master/relatorio/:id — dados completos para PDF de desempenho
app.get('/master/relatorio/:id', masterMiddleware, async (req, res) => {
  try {
    const u = await pool.query(
      'SELECT id, nome, sobrenome, email, codigo, nivel, instituicao, data_inicio FROM usuarios WHERE id = $1',
      [req.params.id]
    );
    if (u.rows.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

    const prog = await pool.query(
      `SELECT semana, habilidade, concluido, concluido_em
       FROM progresso WHERE usuario_id = $1 ORDER BY semana, habilidade`,
      [req.params.id]
    );

    const NIVEL = { basic: 'Basic (A1→A2)', pre: 'Pre-intermediate (A2→B1)', inter: 'Intermediate (B1→B2)', adv: 'Advanced (B2→C1)' };
    const SKILLS = ['listening', 'reading', 'speaking', 'writing'];

    // Montar relatório semana a semana
    const semanas = [];
    for (let s = 0; s < 16; s++) {
      const hab = {};
      SKILLS.forEach(sk => {
        const row = prog.rows.find(p => parseInt(p.semana) === s && p.habilidade === sk);
        hab[sk] = row ? { concluido: row.concluido, data: row.concluido_em } : { concluido: false, data: null };
      });
      const concluidas = SKILLS.filter(sk => hab[sk].concluido).length;
      semanas.push({ semana: s + 1, habilidades: hab, concluidas, completa: concluidas === 4 });
    }

    const total_completas = semanas.filter(s => s.completa).length;

    res.json({
      aluno: {
        ...u.rows[0],
        nivel_nome: NIVEL[u.rows[0].nivel] || u.rows[0].nivel,
        data_inicio_fmt: u.rows[0].data_inicio ? new Date(u.rows[0].data_inicio).toLocaleDateString('pt-BR') : '—'
      },
      semanas,
      resumo: {
        semanas_completas: total_completas,
        percentual_geral: Math.round(total_completas / 16 * 100),
        habilidades_concluidas: prog.rows.filter(p => p.concluido).length,
        total_habilidades: prog.rows.length
      }
    });
  } catch (err) {
    console.error('[RELATORIO]', err);
    res.status(500).json({ error: 'Erro ao gerar relatório.' });
  }
});


// POST /asst — assistente de dúvidas bilíngue
app.post('/asst', authMiddleware, (req, res) => {
  const { question, context } = req.body;
  if (!question || !question.trim()) return res.status(400).json({ error: 'Pergunta obrigatória.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API não configurada.' });

  const https = require('https');
  const prompt = 'You are a bilingual English/Portuguese teaching assistant for Brazilian students learning English.'
    + ' Context: ' + (context || 'CEFR A1-A2 English learner.')
    + ' The student asks: "' + question.trim() + '".'
    + ' Respond in BILINGUAL format: explain in Portuguese first, then give English examples.'
    + ' Be friendly, concise and encouraging. Max 120 words.';

  const bodyData = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(bodyData)
    },
    timeout: 20000
  };

  const chunks = [];
  const req2 = https.request(options, (r2) => {
    r2.on('data', c => chunks.push(c));
    r2.on('end', () => {
      try {
        const raw = JSON.parse(Buffer.concat(chunks).toString());
        const text = (raw.content && raw.content[0] && raw.content[0].text) || '';
        res.json({ text });
      } catch(e) {
        res.status(500).json({ error: 'Erro ao processar resposta.' });
      }
    });
  });
  req2.on('error', () => res.status(500).json({ error: 'Erro de rede.' }));
  req2.on('timeout', () => { req2.destroy(); res.status(504).json({ error: 'Timeout.' }); });
  req2.write(bodyData);
  req2.end();
});

// POST /speaking-fb — feedback de speaking via IA
app.post('/speaking-fb', authMiddleware, (req, res) => {
  const { transcript, prompts, cefr } = req.body;
  if (!transcript || !transcript.trim()) return res.status(400).json({ error: 'Transcrição obrigatória.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API não configurada.' });

  const https = require('https');
  const prompt = 'You are an encouraging English speaking coach for Brazilian students at CEFR level ' + (cefr || 'A1-A2') + '.'
    + ' The student was asked to speak about: "' + (prompts || '') + '".'
    + ' Their spoken response (transcribed): "' + transcript.trim() + '".'
    + ' Give feedback in BILINGUAL format (Portuguese + English examples).'
    + ' Structure: 1) O que foi bom (2 points) 2) O que melhorar (2 points) 3) Uma frase modelo em inglês.'
    + ' Be encouraging. Max 150 words.';

  const bodyData = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }]
  });

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(bodyData)
    },
    timeout: 30000
  };

  const chunks = [];
  const req2 = https.request(options, (r2) => {
    r2.on('data', c => chunks.push(c));
    r2.on('end', () => {
      try {
        const raw = JSON.parse(Buffer.concat(chunks).toString());
        const text = (raw.content && raw.content[0] && raw.content[0].text) || '';
        res.json({ text });
      } catch(e) {
        res.status(500).json({ error: 'Erro ao processar resposta.' });
      }
    });
  });
  req2.on('error', () => res.status(500).json({ error: 'Erro de rede.' }));
  req2.on('timeout', () => { req2.destroy(); res.status(504).json({ error: 'Timeout.' }); });
  req2.write(bodyData);
  req2.end();
});


// GET /master/relatorio-detalhado/:id — relatório pedagógico completo
app.get('/master/relatorio-detalhado/:id', masterMiddleware, async (req, res) => {
  try {
    const uid = req.params.id;

    const u = await pool.query(
      `SELECT id, nome, sobrenome, email, codigo, nivel, instituicao,
              data_inicio, ultimo_acesso
       FROM usuarios WHERE id = $1`,
      [uid]
    );
    if (u.rows.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

    const prog = await pool.query(
      `SELECT semana, habilidade, concluido, concluido_em
       FROM progresso WHERE usuario_id = $1 ORDER BY semana, habilidade`,
      [uid]
    );

    const det = await pool.query(
      `SELECT semana, habilidade, passo, respostas, atualizado_em
       FROM progresso_detalhe WHERE usuario_id = $1 ORDER BY semana, habilidade`,
      [uid]
    );

    const NIVEL = {
      basic: 'Basic (A1→A2)', pre: 'Pre-intermediate (A2→B1)',
      inter: 'Intermediate (B1→B2)', adv: 'Advanced (B2→C1)'
    };
    const SKILLS = ['listening', 'reading', 'speaking', 'writing'];

    // Helper: verifica se uma entrada de resposta está correta,
    // suportando tanto o formato novo (objeto com .correct) quanto o legado (boolean)
    function isCorrect(entry) {
      if (entry && typeof entry === 'object' && 'correct' in entry) return entry.correct === true;
      return entry === true || entry === 'correct';
    }

    // Helper: extrai detalhe de erro legível (questão, escolha do aluno, resposta certa)
    function extractErroDetalhe(key, qi, entry, tipo) {
      if (!entry || typeof entry !== 'object' || !('chosen_text' in entry)) return null;
      return {
        tipo,
        pergunta: entry.question || entry.sentence || ('Questão ' + (parseInt(qi) + 1)),
        resposta_aluno: entry.chosen_text || '—',
        resposta_correta: entry.correct_text || '—',
      };
    }

    const semanas = [];
    for (let s = 0; s < 16; s++) {
      const habilidades = {};
      SKILLS.forEach(sk => {
        const row = prog.rows.find(p => parseInt(p.semana) === s && p.habilidade === sk);
        const detRow = det.rows.find(d => parseInt(d.semana) === s && d.habilidade === sk);
        let respostas = {};
        try { respostas = detRow && detRow.respostas ? (typeof detRow.respostas === 'string' ? JSON.parse(detRow.respostas) : detRow.respostas) : {}; }
        catch(_) { respostas = {}; }

        let acertos = 0, total_q = 0;
        let erros = []; // lista de erros específicos para análise pedagógica

        Object.keys(respostas).forEach(key => {
          const isQuestionBlock = ['mc_','tf_','grammar_','vocab_'].some(p => key.startsWith(p));
          if (!isQuestionBlock) return;
          const bloco = respostas[key];
          if (!bloco || typeof bloco !== 'object') return;

          const tipo = key.startsWith('mc_') ? 'Múltipla escolha'
                     : key.startsWith('tf_') ? 'Verdadeiro/Falso'
                     : key.startsWith('grammar_') ? 'Gramática'
                     : 'Vocabulário';

          Object.keys(bloco).forEach(qi => {
            total_q++;
            const entry = bloco[qi];
            const ok = isCorrect(entry);
            if (ok) {
              acertos++;
            } else {
              const detalhe = extractErroDetalhe(key, qi, entry, tipo);
              if (detalhe) erros.push(detalhe);
            }
          });
        });

        habilidades[sk] = {
          concluido:    row ? row.concluido : false,
          concluido_em: row ? row.concluido_em : null,
          passo_atual:  detRow ? detRow.passo : 0,
          atualizado_em: detRow ? detRow.atualizado_em : null,
          acertos,
          total_questoes: total_q,
          pct_acerto: total_q > 0 ? Math.round(acertos / total_q * 100) : null,
          erros: erros.slice(0, 8), // limitar para não sobrecarregar o prompt
          respostas,
        };
      });

      const concluidas = SKILLS.filter(sk => habilidades[sk].concluido).length;
      semanas.push({
        semana: s + 1,
        habilidades,
        concluidas,
        completa: concluidas === 4,
      });
    }

    const total_completas = semanas.filter(s => s.completa).length;
    const total_hab_concluidas = semanas.reduce((acc, s) =>
      acc + SKILLS.filter(sk => s.habilidades[sk].concluido).length, 0);

    let total_acertos = 0, total_questoes = 0;
    semanas.forEach(s => {
      SKILLS.forEach(sk => {
        total_acertos  += s.habilidades[sk].acertos || 0;
        total_questoes += s.habilidades[sk].total_questoes || 0;
      });
    });

    res.json({
      aluno: {
        ...u.rows[0],
        nivel_nome: NIVEL[u.rows[0].nivel] || u.rows[0].nivel,
        data_inicio_fmt: u.rows[0].data_inicio
          ? new Date(u.rows[0].data_inicio).toLocaleDateString('pt-BR') : '—',
        ultimo_acesso_fmt: u.rows[0].ultimo_acesso
          ? new Date(u.rows[0].ultimo_acesso).toLocaleString('pt-BR') : '—',
      },
      semanas,
      resumo: {
        semanas_completas:     total_completas,
        percentual_geral:      Math.round(total_completas / 16 * 100),
        habilidades_concluidas: total_hab_concluidas,
        total_habilidades:     prog.rows.length,
        media_acertos:         total_questoes > 0 ? Math.round(total_acertos / total_questoes * 100) : null,
        total_acertos,
        total_questoes,
      }
    });
  } catch (err) {
    console.error('[REL-DET]', err);
    res.status(500).json({ error: 'Erro ao gerar relatório detalhado.' });
  }
});


// POST /master/relatorio-pedagogico/:id — análise descritiva por IA
app.post('/master/relatorio-pedagogico/:id', masterMiddleware, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'API não configurada.' });

  try {
    const uid = req.params.id;
    const { semanas_data, aluno_info } = req.body;

    const nomeAluno   = (aluno_info && aluno_info.nome)             || 'o aluno';
    const nivel       = (aluno_info && aluno_info.nivel)            || 'basic';
    const semComp     = (aluno_info && aluno_info.semanas_completas) || 0;
    const pctGeral    = (aluno_info && aluno_info.pct_geral)        || 0;

    // ── Mapa pedagógico fixo das semanas (do activities.js) ──────────────
    const SEMANAS_CONTEUDO = {
      1: {
        tema: "Diagnostic Week — First Day at the Language Centre",
        topicos: ["Apresentacao pessoal","Verbo TO BE","Pronomes pessoais e possessivos","Numeros, nacionalidades, profissoes"],
        grammar: "Verbo TO BE — presente simples (afirmativa, negativa, interrogativa)",
        writing_min: 60,
        reading_text: "Tres perfis: Tom, Fatima, Lucas — identidade, rotinas e preferencias",
        speaking_context: "Apresentacao pessoal e perguntas sobre identidade"
      },
      2: {
        tema: "Daily Routines — A Morning at Home",
        topicos: ["Vocabulario de rotina diaria","Adverbios de frequencia (always, usually, often, sometimes, never)","Expressoes de tempo (first, then, after that, finally)","Present Simple — habitos"],
        grammar: "Adverbios de frequencia — posicao na frase (antes do verbo principal, depois do TO BE)",
        writing_min: 80,
        reading_text: "Rotinas de Hana (Toquio), Pedro (Buenos Aires), Amina (Nairobi)",
        speaking_context: "Descricao de rotina matinal com expressoes de tempo"
      },
      3: {
        tema: "At School — Subjects and Timetables",
        topicos: ["Vocabulario escolar (subject, timetable, break, classmate, homework)","Question words (What, When, Where, Who, How)","Present Simple — perguntas e negativas (do/does, dont/doesnt)"],
        grammar: "Present Simple — questions e negatives com DO/DOES (base verb sem -s depois de does)",
        writing_min: 90,
        reading_text: "Tom (Londres), Yuki (Osaka), Marco (Sao Paulo) descrevem rotina escolar",
        speaking_context: "Perguntas e respostas sobre vida escolar com question words"
      },
      4: {
        tema: "Free Time and Hobbies",
        topicos: ["Vocabulario de hobbies e tempo livre","Modal CAN para habilidade (I can play, she cant swim)","Comparacao de hobbies entre culturas","Conectores: although, however, but"],
        grammar: "CAN / CANT — habilidade (mesma forma para todos os sujeitos, sem -s; base verb depois)",
        writing_min: 100,
        reading_text: "Elena (Espanha/flamenco), Daniel (Africa do Sul/fotografia), Mei (Taiwan/selos), Tomas (Portugal/skate)",
        speaking_context: "Descrever hobbies e habilidades usando can e cant com exemplos pessoais"
      },
      5: {
        tema: "Food and Health — What Do You Usually Eat?",
        topicos: ["Vocabulario de alimentos e refeicoes","There is/are + some (afirmativas) / any (negativas e perguntas)","Much/many com contaveis e incontaveis","Habitos alimentares e saude"],
        grammar: "There is/There are + some/any (some em positivas, any em negativas e perguntas)",
        writing_min: 110,
        reading_text: "Carlos (Mexico), Fatima (Marrocos), Kenji (Japao), Sofia (Sao Paulo) — habitos alimentares",
        speaking_context: "Descrever comida em casa usando there is/are some/any em contexto real"
      },
      6: {
        tema: "A Memorable Trip — Travelling and Past Events",
        topicos: ["Vocabulario de viagem (historic, spectacular, steep, stunning, nostalgic)","Past Simple — verbos regulares (-ed) e irregulares (go/went, fly/flew, wake/woke, eat/ate, take/took, feel/felt)","Negative: didnt + base verb","Questions: Did + subject + base verb?","Sequencing connectors: first, then, after that, on the second day, finally"],
        grammar: "Past Simple — regulares (+ed) e irregulares: go/went, fly/flew, wake/woke, eat/ate, take/took, feel/felt, find/found, meet/met, see/saw. Negative: didnt + base verb. Question: Did + base verb?",
        writing_min: 120,
        reading_text: "Isabela (Brasil/Dublin), Marcus (Africa do Sul/Sudeste Asiatico), Yuki (Japao/competicao de robotica) — viagens marcantes",
        speaking_context: "Narrar uma viagem memoravel usando Past Simple e conectores de sequencia (first, then, finally)"
      }
    };

    // ── Construir dados de desempenho por semana/habilidade ───────────────
    let dadosPorSemana = [];
    let totalAcertos = 0, totalQuestoes = 0;
    let habConcluidas = { listening:0, reading:0, speaking:0, writing:0 };
    let semanasFeitas = 0;

    if (semanas_data && semanas_data.length) {
      semanas_data.forEach(s => {
        const habsDone = Object.keys(s.habilidades || {})
          .filter(sk => s.habilidades[sk] && s.habilidades[sk].concluido);
        if (!habsDone.length) return;
        semanasFeitas++;

        const conteudo = SEMANAS_CONTEUDO[s.semana] || {};
        const semInfo = {
          semana: s.semana,
          tema: conteudo.tema || `Semana ${s.semana}`,
          completa: s.completa,
          habilidades: {}
        };

        habsDone.forEach(sk => {
          habConcluidas[sk]++;
          const h = s.habilidades[sk];
          let ac = 0, tot = 0;
          let textoEscrito = '';
          let falasTranscrita = '';

          if (h.respostas) {
            Object.keys(h.respostas).forEach(key => {
              if (['mc_','tf_','grammar_','vocab_'].some(p => key.startsWith(p))) {
                const bloco = h.respostas[key];
                if (bloco && typeof bloco === 'object') {
                  Object.keys(bloco).forEach(qi => {
                    tot++; if (bloco[qi] === true) ac++;
                  });
                }
              }
            });
            if (h.respostas.write_text) textoEscrito = String(h.respostas.write_text).substring(0,400);
            if (h.respostas.speaking_transcript) falasTranscrita = String(h.respostas.speaking_transcript).substring(0,300);
          }

          totalAcertos  += ac;
          totalQuestoes += tot;

          semInfo.habilidades[sk] = {
            pct: h.pct_acerto !== null && h.pct_acerto !== undefined ? h.pct_acerto : (tot > 0 ? Math.round(ac/tot*100) : null),
            acertos: ac, total: tot,
            data: h.concluido_em ? new Date(h.concluido_em).toLocaleDateString('pt-BR') : null,
            texto: textoEscrito,
            fala: falasTranscrita,
            erros: h.erros || [],
          };
        });
        dadosPorSemana.push(semInfo);
      });
    }

    // ── Montar bloco de dados para o prompt ───────────────────────────────
    let blocoDesempenho = '';
    dadosPorSemana.forEach(s => {
      const c = SEMANAS_CONTEUDO[s.semana] || {};
      blocoDesempenho += `\n\n═══ SEMANA ${s.semana}: ${s.tema} ${s.completa ? '[COMPLETA]' : '[PARCIAL]'} ═══`;
      blocoDesempenho += `\nConteúdo trabalhado: ${(c.topicos||[]).join(' | ')}`;
      blocoDesempenho += `\nFoco gramatical: ${c.grammar || 'N/D'}`;

      const SKILL_LABEL = {listening:'LISTENING',reading:'READING',speaking:'SPEAKING',writing:'WRITING'};
      Object.entries(s.habilidades).forEach(([sk, h]) => {
        blocoDesempenho += `\n\n  [${SKILL_LABEL[sk]}]`;
        if (h.pct !== null) {
          blocoDesempenho += ` — ${h.pct}% de acerto`;
          if (h.total > 0) blocoDesempenho += ` (${h.acertos}/${h.total} questões)`;
          if (h.data) blocoDesempenho += ` — concluído em ${h.data}`;
        } else {
          blocoDesempenho += ` — concluído (sem registro de questões individuais)`;
        }
        if (sk === 'writing' && c.writing_min) {
          blocoDesempenho += `\n  Tarefa de escrita: produção mínima de ${c.writing_min} palavras | tema: ${c.tema || 'N/D'}`;
        }
        if (sk === 'reading' && c.reading_text) {
          blocoDesempenho += `\n  Textos lidos: ${c.reading_text}`;
        }
        if (sk === 'speaking' && c.speaking_context) {
          blocoDesempenho += `\n  Contexto oral: ${c.speaking_context}`;
        }
        if (h.texto) blocoDesempenho += `\n  Amostra de escrita: "${h.texto}"`;
        if (h.fala)  blocoDesempenho += `\n  Transcrição de fala: "${h.fala}"`;
        if (h.erros && h.erros.length) {
          blocoDesempenho += `\n  Erros específicos registrados:`;
          h.erros.forEach(e => {
            blocoDesempenho += `\n    • [${e.tipo}] "${e.pergunta}" — aluno respondeu "${e.resposta_aluno}", correto era "${e.resposta_correta}"`;
          });
        }
      });
    });

    if (!blocoDesempenho) {
      blocoDesempenho = '\nNenhuma atividade concluída registrada no sistema. O aluno está no início do programa.';
    }

    const mediaAcertos = totalQuestoes > 0 ? Math.round(totalAcertos/totalQuestoes*100) : null;
    const perfilEstatistico = `Semanas completas: ${semComp}/16 (${pctGeral}%) | Habilidades: L=${habConcluidas.listening} R=${habConcluidas.reading} S=${habConcluidas.speaking} W=${habConcluidas.writing} | Média de acertos: ${mediaAcertos !== null ? mediaAcertos+'%' : 'sem dados'}`;

    // ── Prompt pedagógico ─────────────────────────────────────────────────
    const prompt = `Você é um especialista em avaliação de inglês como língua estrangeira (EFL), com sólida formação em descritores CEFR A1-A2 e experiência em ensino comunicativo de idiomas.

Produza um RELATÓRIO PEDAGÓGICO INDIVIDUAL completo, em português brasileiro, para o professor responsável pela turma.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ALUNO: ${nomeAluno}
Nível: Basic (A1→A2) | Programa: 16 semanas
${perfilEstatistico}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DADOS DE DESEMPENHO (extraídos da plataforma Lenglish):
${blocoDesempenho}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ESTRUTURA OBRIGATÓRIA DO RELATÓRIO:

**LISTENING — Compreensão Oral**
Descreva o desempenho do aluno nas atividades de compreensão oral realizadas. Inclua: nível demonstrado, capacidade de identificar informações específicas, reconhecimento de vocabulário em contexto auditivo. Se há dados de acertos, interprete-os pedagogicamente. Cite o conteúdo trabalhado.

**READING — Compreensão Leitora**
Analise o desempenho nas leituras. Inclua: capacidade de localizar informação, inferência, compreensão de vocabulário contextual e habilidade de reflexão escrita (reflection). Cite os textos trabalhados.

**SPEAKING — Produção Oral**
Avalie a habilidade oral com base nas atividades de pronúncia, diálogo e produção livre. Inclua: fluência esperada para o nível, capacidade de interação, uso de expressões-alvo. Se há transcrição, analise-a.

**WRITING — Produção Escrita**
Analise a produção escrita. Inclua: domínio gramatical (especialmente o foco gramatical da semana), organização textual, vocabulário utilizado, atendimento ao mínimo de palavras. Se há amostra de texto, analise-a diretamente.

**SÍNTESE DO PERFIL DE APRENDIZAGEM**
Integre as quatro competências numa visão holística do aluno. Identifique pontos fortes, padrões de dificuldade e ritmo de aprendizagem.

**RECOMENDAÇÕES PEDAGÓGICAS**
Liste 4 a 6 ações concretas e específicas para o professor: atividades complementares, foco de atenção nas próximas semanas, estratégias de intervenção personalizadas para este aluno.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DIRETRIZES:
- Use linguagem técnica mas acessível
- Seja específico: cite conteúdos, gramática e atividades pelo nome
- NÃO use termos genéricos como "o aluno demonstrou bom desempenho" sem fundamento nos dados
- Se os dados forem limitados, baseie a análise no descritor CEFR A1 e no conteúdo trabalhado nas semanas concluídas
- Quando houver "Erros específicos registrados", analise o PADRÃO dos erros (ex: confusão entre tempos verbais, vocabulário específico, falsos cognatos) — não apenas reporte o percentual
- Use os erros específicos para fundamentar recomendações pedagógicas concretas e individualizadas
- Tamanho mínimo: 600 palavras`;

    const https = require('https');
    const bodyData = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(bodyData)
      },
      timeout: 60000
    };

    const chunks = [];
    const req2 = https.request(options, (r2) => {
      r2.on('data', c => chunks.push(c));
      r2.on('end', () => {
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString());
          if (raw.error) {
            console.error('[PED] API error:', JSON.stringify(raw.error));
            return res.status(500).json({ error: 'Erro da API: ' + (raw.error.message || JSON.stringify(raw.error)) });
          }
          const text = (raw.content && raw.content[0] && raw.content[0].text) || '';
          if (!text) {
            console.error('[PED] Texto vazio. stop_reason:', raw.stop_reason, '| usage:', JSON.stringify(raw.usage));
            return res.status(500).json({ error: 'Resposta vazia da IA.' });
          }
          res.json({ analise: text });
        } catch(e) {
          console.error('[PED] Parse:', e.message);
          res.status(500).json({ error: 'Erro ao processar.' });
        }
      });
    });
    req2.on('error', e => { console.error('[PED] Net:', e.message); res.status(500).json({ error: 'Erro de rede.' }); });
    req2.on('timeout', () => { req2.destroy(); res.status(504).json({ error: 'Timeout.' }); });
    req2.write(bodyData);
    req2.end();

  } catch (err) {
    console.error('[PED]', err);
    res.status(500).json({ error: 'Erro interno.' });
  }
});



// GET /master/progresso-geral — resumo de progresso de todos os alunos aprovados (uma só chamada)
app.get('/master/progresso-geral', masterMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         u.id, u.nome, u.sobrenome, u.codigo, u.nivel, u.instituicao,
         u.data_inicio, u.ultimo_acesso,
         COUNT(p.id) FILTER (WHERE p.concluido = true) AS hab_concluidas,
         COUNT(p.id) AS hab_total,
         COUNT(DISTINCT p.semana) FILTER (
           WHERE p.concluido = true AND (
             SELECT COUNT(*) FROM progresso p2
             WHERE p2.usuario_id = u.id AND p2.semana = p.semana AND p2.concluido = true
           ) = 4
         ) AS semanas_completas
       FROM usuarios u
       LEFT JOIN progresso p ON p.usuario_id = u.id
       WHERE u.status_cadastro = 'aprovado'
       GROUP BY u.id
       ORDER BY u.data_inicio DESC`
    );

    const alunos = result.rows.map(r => ({
      id:                parseInt(r.id),
      nome:              r.nome,
      sobrenome:         r.sobrenome,
      codigo:            r.codigo,
      nivel:             r.nivel,
      instituicao:       r.instituicao,
      data_inicio:       r.data_inicio,
      ultimo_acesso:     r.ultimo_acesso,
      hab_concluidas:    parseInt(r.hab_concluidas) || 0,
      hab_total:         parseInt(r.hab_total) || 64,
      semanas_completas: parseInt(r.semanas_completas) || 0,
      percentual:        Math.round((parseInt(r.semanas_completas) || 0) / 16 * 100),
    }));

    res.json({ alunos });
  } catch (err) {
    console.error('[PROG-GERAL]', err);
    res.status(500).json({ error: 'Erro ao buscar progresso geral.' });
  }
});


// PATCH /master/aluno/:id/resetar-senha — professor define nova senha para o aluno
app.patch('/master/aluno/:id/resetar-senha', masterMiddleware, async (req, res) => {
  const { senha_nova } = req.body;
  if (!senha_nova || senha_nova.length < 6) {
    return res.status(400).json({ error: 'Senha nova deve ter mínimo 6 caracteres.' });
  }
  try {
    const u = await pool.query(
      'SELECT nome, email, codigo FROM usuarios WHERE id = $1',
      [req.params.id]
    );
    if (u.rows.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

    const novaHash = await bcrypt.hash(senha_nova, 10);
    await pool.query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [novaHash, req.params.id]);

    const aluno = u.rows[0];

    // Notificar o aluno por e-mail (best-effort, não bloqueia a resposta)
    if (aluno.email) {
      resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'noreply@lenglish.com.br',
        to: aluno.email,
        subject: 'Sua senha foi redefinida — Lenglish',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
            <h1 style="color:#0033A0;font-size:28px;margin-bottom:4px">Leng<span style="color:#CC0000">lish</span></h1>
            <p style="color:#78766E;font-size:13px;margin-bottom:24px">English Learning Platform</p>
            <p style="font-size:15px;color:#1C1C1A">Olá, <strong>${aluno.nome}</strong>!</p>
            <p style="font-size:14px;color:#78766E">
              Sua senha de acesso à plataforma foi redefinida pelo professor.
            </p>
            <p style="font-size:13px;color:#78766E;margin-top:12px">
              Use seu código de acesso (<strong style="font-family:monospace">${aluno.codigo}</strong>)
              junto com a nova senha fornecida pelo professor para entrar em
              <a href="https://lenglish.com.br" style="color:#0033A0">lenglish.com.br</a>.
            </p>
            <p style="font-size:12px;color:#B0AEA6;margin-top:24px">
              Se você não esperava esta alteração, contate sua instituição imediatamente.
            </p>
          </div>
        `
      }).catch(err => console.error('Erro email reset senha:', err));
    }

    res.json({ ok: true, message: `Senha de ${aluno.nome} redefinida com sucesso.` });
  } catch (err) {
    console.error('[RESET-SENHA]', err);
    res.status(500).json({ error: 'Erro ao redefinir senha.' });
  }
});

// Rota de versão — confirma qual código está rodando
app.get('/version', (req, res) => {
  res.json({
    version: '3.0',
    routes: [
      '/auth/enviar-codigo','/auth/registro','/auth/login','/auth/recuperar-codigo',
      '/perfil','/perfil/senha',
      '/progresso','/progresso/concluir','/progresso/passo',
      '/tts','/tts-test','/dict','/asst','/speaking-fb',
      '/mensagens','/mensagens/professor','/mensagens/nao-lidas','/mensagens/marcar-lidas',
      '/master/cadastros','/master/cadastros/:id/aprovar','/master/cadastros/:id/rejeitar',
      '/master/alunos','/master/aluno/:id','/master/stats',
      '/master/relatorio/:id','/master/relatorio-detalhado/:id','/master/mensagens','/master/mensagens/:usuario_id',
      '/master/criar-teste','/master/reset-progresso/:email','/master/aluno/:id/resetar-senha'
    ],
    timestamp: new Date().toISOString()
  });
});

// POST /auth/recuperar-codigo — envia o código do aluno por email
app.post('/auth/recuperar-codigo', otpLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'E-mail inválido.' });
  }
  try {
    const result = await pool.query(
      'SELECT nome, codigo FROM usuarios WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'E-mail não encontrado.' });
    }
    const { nome, codigo } = result.rows[0];
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'noreply@lenglish.com.br',
      to: email,
      subject: 'Seu código de acesso Lenglish',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
          <h1 style="color:#0033A0;font-size:28px;margin-bottom:4px">Leng<span style="color:#CC0000">lish</span></h1>
          <p style="color:#78766E;font-size:13px;margin-bottom:24px">English Learning Platform</p>
          <p style="font-size:15px;color:#1C1C1A">Olá, <strong>${nome}</strong>!</p>
          <p style="font-size:14px;color:#78766E">Seu código de acesso é:</p>
          <div style="font-size:28px;font-weight:900;letter-spacing:4px;color:#0033A0;background:#E8EEFA;border-radius:8px;padding:16px 24px;display:inline-block;font-family:monospace;margin:12px 0">${codigo}</div>
          <p style="font-size:13px;color:#78766E;margin-top:16px">Use este código junto com sua senha para acessar a plataforma em <a href="https://lenglish.com.br" style="color:#0033A0">lenglish.com.br</a>.</p>
        </div>
      `
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro recuperar código:', err);
    res.status(500).json({ error: 'Erro ao enviar e-mail.' });
  }
});


// ═══════════════════════════════════════════════════════
// MASTER — Gestão de cadastros
// ═══════════════════════════════════════════════════════

// GET /master/cadastros — listar todos (com filtro por status)
app.get('/master/cadastros', masterMiddleware, async (req, res) => {
  const { status } = req.query;
  try {
    const params = status ? [status] : [];
    const where  = status ? 'WHERE status_cadastro = $1' : '';
    const result = await pool.query(
      `SELECT id, nome, sobrenome, email, codigo, nivel, whatsapp,
              instituicao, status_cadastro, criado_em, ultimo_acesso
       FROM usuarios
       ${where}
       ORDER BY criado_em DESC`,
      params
    );
    res.json({ usuarios: result.rows });
  } catch (err) {
    console.error('Erro listar cadastros:', err);
    res.status(500).json({ error: 'Erro ao listar cadastros.' });
  }
});

// PATCH /master/cadastros/:id/aprovar
app.patch('/master/cadastros/:id/aprovar', masterMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE usuarios SET status_cadastro = 'aprovado'
       WHERE id = $1 RETURNING nome, sobrenome, email, codigo`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    const u = result.rows[0];
    // Enviar email de aprovação
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'noreply@lenglish.com.br',
        to: u.email,
        subject: 'Cadastro aprovado — Lenglish',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
            <h1 style="color:#0033A0;font-size:28px;margin-bottom:4px">Leng<span style="color:#CC0000">lish</span></h1>
            <p style="color:#78766E;font-size:13px;margin-bottom:24px">English Learning Platform</p>
            <p style="font-size:15px;color:#1C1C1A">Olá, <strong>${u.nome}</strong>!</p>
            <p style="font-size:14px;color:#78766E;margin-bottom:16px">
              Seu cadastro foi <strong style="color:#1A7A3C">aprovado</strong>! 
              Você já pode acessar a plataforma.
            </p>
            <div style="background:#E8EEFA;border-radius:8px;padding:16px 24px;margin:16px 0">
              <p style="font-size:12px;color:#78766E;margin-bottom:4px">Seu código de acesso:</p>
              <p style="font-size:24px;font-weight:900;color:#0033A0;font-family:monospace;letter-spacing:4px">${u.codigo}</p>
            </div>
            <p style="font-size:13px;color:#78766E">
              Acesse em <a href="https://lenglish.com.br" style="color:#0033A0">lenglish.com.br</a>
              e faça login com seu código e senha.
            </p>
            <p style="font-size:12px;color:#B0AEA6;margin-top:24px">
              As atividades começam em 1° de junho de 2026.
            </p>
          </div>
        `
      });
    } catch (emailErr) {
      console.error('Erro email aprovação:', emailErr);
    }
    res.json({ ok: true, message: `${u.nome} aprovado com sucesso.` });
  } catch (err) {
    console.error('Erro aprovar:', err);
    res.status(500).json({ error: 'Erro ao aprovar cadastro.' });
  }
});

// PATCH /master/cadastros/:id/rejeitar
app.patch('/master/cadastros/:id/rejeitar', masterMiddleware, async (req, res) => {
  const { motivo } = req.body;
  try {
    const result = await pool.query(
      `UPDATE usuarios SET status_cadastro = 'rejeitado'
       WHERE id = $1 RETURNING nome, sobrenome, email, codigo`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    const u = result.rows[0];
    try {
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'noreply@lenglish.com.br',
        to: u.email,
        subject: 'Cadastro não aprovado — Lenglish',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
            <h1 style="color:#0033A0;font-size:28px;margin-bottom:4px">Leng<span style="color:#CC0000">lish</span></h1>
            <p style="color:#78766E;font-size:13px;margin-bottom:24px">English Learning Platform</p>
            <p style="font-size:15px;color:#1C1C1A">Olá, <strong>${u.nome}</strong>!</p>
            <p style="font-size:14px;color:#78766E;margin-bottom:16px">
              Infelizmente seu cadastro <strong style="color:#CC0000">não foi aprovado</strong> no momento.
              ${motivo ? `<br><br><em>${motivo}</em>` : ''}
            </p>
            <p style="font-size:13px;color:#78766E">
              Em caso de dúvidas, entre em contato com sua instituição.
            </p>
          </div>
        `
      });
    } catch (emailErr) {
      console.error('Erro email rejeição:', emailErr);
    }
    res.json({ ok: true, message: `${u.nome} rejeitado.` });
  } catch (err) {
    console.error('Erro rejeitar:', err);
    res.status(500).json({ error: 'Erro ao rejeitar cadastro.' });
  }
});


// ═══════════════════════════════════════════════════════
// TTS — Text-to-Speech via OpenAI
// ═══════════════════════════════════════════════════════
// Rota de teste TTS — sem auth, apenas para validar chave OpenAI
app.get('/tts-test', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.json({ ok: false, error: 'OPENAI_API_KEY não configurada' });
  }
  const https = require('https');
  const body = JSON.stringify({ model:'tts-1', input:'Hello!', voice:'nova', response_format:'mp3' });
  const options = {
    hostname: 'api.openai.com',
    path: '/v1/audio/speech',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };
  const req2 = https.request(options, (r) => {
    let data = [];
    r.on('data', chunk => data.push(chunk));
    r.on('end', () => {
      if(r.statusCode === 200){
        res.json({ ok: true, status: r.statusCode, bytes: Buffer.concat(data).length });
      } else {
        res.json({ ok: false, status: r.statusCode, body: Buffer.concat(data).toString().substring(0,200) });
      }
    });
  });
  req2.on('error', e => res.json({ ok: false, error: e.message }));
  req2.write(body);
  req2.end();
});

app.post('/tts', authMiddleware, async (req, res) => {
  const { text, voice = 'nova' } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Texto obrigatório.' });
  }
  if (text.length > 4096) {
    return res.status(400).json({ error: 'Texto muito longo.' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'TTS não configurado.' });
  }

  console.log('[TTS] Iniciando, texto:', text.trim().substring(0, 50));

  // Usar https nativo do Node (sempre disponível, sem fetch)
  const https = require('https');
  const bodyData = JSON.stringify({
    model: 'tts-1',
    input: text.trim(),
    voice: voice || 'nova',
    response_format: 'mp3',
  });

  const options = {
    hostname: 'api.openai.com',
    path: '/v1/audio/speech',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyData),
    },
    timeout: 30000,
  };

  const chunks = [];
  const request = https.request(options, (response) => {
    console.log('[TTS] OpenAI status:', response.statusCode);
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      const buffer = Buffer.concat(chunks);
      if (response.statusCode === 200) {
        res.set({
          'Content-Type': 'audio/mpeg',
          'Content-Length': buffer.length,
          'Cache-Control': 'public, max-age=86400',
        });
        res.send(buffer);
      } else {
        const errText = buffer.toString();
        console.error('[TTS] OpenAI erro:', response.statusCode, errText.substring(0, 200));
        let errMsg = 'Erro ao gerar áudio.';
        try { errMsg = JSON.parse(errText)?.error?.message || errMsg; } catch(_) {}
        res.status(502).json({ error: errMsg, openai_status: response.statusCode });
      }
    });
  });

  request.on('error', (err) => {
    console.error('[TTS] Erro de rede:', err.message);
    res.status(500).json({ error: 'Erro de conexão com OpenAI: ' + err.message });
  });

  request.on('timeout', () => {
    console.error('[TTS] Timeout na chamada OpenAI');
    request.destroy();
    res.status(504).json({ error: 'Timeout ao gerar áudio. Tente novamente.' });
  });

  request.write(bodyData);
  request.end();
});

// ═══════════════════════════════════════════════════════
// MENSAGENS — Canal aluno ↔ professor
// ═══════════════════════════════════════════════════════

// GET /mensagens — listar mensagens do aluno
app.get('/mensagens', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.id, m.remetente_tipo, m.conteudo, m.lida, m.criado_em,
              u.nome AS nome_remetente, u.codigo AS codigo_remetente
       FROM mensagens m
       LEFT JOIN usuarios u ON m.remetente_id = u.id
       WHERE m.usuario_id = $1
       ORDER BY m.criado_em ASC`,
      [req.user.id]
    );
    res.json({ mensagens: result.rows });
  } catch (err) {
    console.error('Erro mensagens:', err);
    res.status(500).json({ error: 'Erro ao carregar mensagens.' });
  }
});

// POST /mensagens — aluno envia mensagem
app.post('/mensagens', authMiddleware, async (req, res) => {
  const { conteudo } = req.body;
  if (!conteudo || !conteudo.trim()) {
    return res.status(400).json({ error: 'Mensagem vazia.' });
  }
  if (conteudo.length > 1000) {
    return res.status(400).json({ error: 'Mensagem muito longa (máx. 1000 caracteres).' });
  }
  try {
    await pool.query(
      `INSERT INTO mensagens (usuario_id, remetente_id, remetente_tipo, conteudo)
       VALUES ($1, $1, 'aluno', $2)`,
      [req.user.id, conteudo.trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro enviar mensagem:', err);
    res.status(500).json({ error: 'Erro ao enviar mensagem.' });
  }
});

// POST /mensagens/professor — professor responde (requer master token)
app.post('/mensagens/professor', masterMiddleware, async (req, res) => {
  const { usuario_id, conteudo } = req.body;
  if (!usuario_id || !conteudo || !conteudo.trim()) {
    return res.status(400).json({ error: 'usuario_id e conteudo são obrigatórios.' });
  }
  try {
    await pool.query(
      `INSERT INTO mensagens (usuario_id, remetente_id, remetente_tipo, conteudo)
       VALUES ($1, NULL, 'professor', $2)`,
      [usuario_id, conteudo.trim()]
    );
    // Marcar todas as mensagens do aluno como lidas pelo professor
    await pool.query(
      `UPDATE mensagens SET lida = true
       WHERE usuario_id = $1 AND remetente_tipo = 'aluno' AND lida = false`,
      [usuario_id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro resposta professor:', err);
    res.status(500).json({ error: 'Erro ao enviar resposta.' });
  }
});

// GET /mensagens/nao-lidas — contagem de msgs não lidas do aluno
app.get('/mensagens/nao-lidas', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS total FROM mensagens
       WHERE usuario_id = $1 AND remetente_tipo = 'professor' AND lida = false`,
      [req.user.id]
    );
    res.json({ total: parseInt(result.rows[0].total) });
  } catch (err) {
    res.status(500).json({ error: 'Erro.' });
  }
});

// PATCH /mensagens/marcar-lidas — aluno marca msgs do professor como lidas
app.patch('/mensagens/marcar-lidas', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      `UPDATE mensagens SET lida = true
       WHERE usuario_id = $1 AND remetente_tipo = 'professor' AND lida = false`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro.' });
  }
});

// GET /master/mensagens — professor vê todas as conversas
app.get('/master/mensagens', masterMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.nome, u.sobrenome, u.codigo, u.nivel,
              COUNT(m.id) FILTER (WHERE m.remetente_tipo='aluno' AND m.lida=false) AS nao_lidas,
              MAX(m.criado_em) AS ultima_msg
       FROM usuarios u
       LEFT JOIN mensagens m ON m.usuario_id = u.id
       GROUP BY u.id
       HAVING COUNT(m.id) > 0
       ORDER BY nao_lidas DESC, ultima_msg DESC`
    );
    res.json({ alunos: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro.' });
  }
});

// GET /master/mensagens/:usuario_id — professor vê conversa com aluno
app.get('/master/mensagens/:usuario_id', masterMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, remetente_tipo, conteudo, lida, criado_em
       FROM mensagens WHERE usuario_id = $1 ORDER BY criado_em ASC`,
      [req.params.usuario_id]
    );
    res.json({ mensagens: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erro.' });
  }
});

  

}).catch(err => {
  console.error('❌ Erro ao inicializar banco:', err);
  process.exit(1);
});
