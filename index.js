const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const app = express();
const SALT_ROUNDS = 12;
app.use(compression()); // gzip

// A4: headers de segurança
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

// ── CORS ──────────────────────────────────────────────────────────────
const allowedOrigins = [
  'https://redacheck.com.br',
  'https://www.redacheck.com.br',
  'https://merry-valkyrie-60e85b.netlify.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (origin.endsWith('.netlify.app')) return callback(null, true);
    callback(new Error('CORS: origem não permitida — ' + origin));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-master-token'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// ── CONEXÃO POSTGRESQL ────────────────────────────────────────────────
if (!process.env.DATABASE_URL) { console.error('❌ DATABASE_URL não configurada!'); process.exit(1); }
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// ── HELPER DE LOG ─────────────────────────────────────────────────────
// Registra qualquer ação do usuário na tabela logs_usuario
// Nunca lança exceção — log nunca deve interromper o fluxo principal
async function log(usuarioId, email, acao, status, detalhes = {}, ip = null) {
  try {
    await pool.query(
      `INSERT INTO logs_usuario (usuario_id, email, acao, status, detalhes, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [usuarioId || null, email || null, acao, status || 'ok', JSON.stringify(detalhes), ip || null]
    );
  } catch (e) {
    console.error('[log] Falha ao registrar log:', e.message);
  }
}

// ── RESEND ────────────────────────────────────────────────────────────
async function enviarEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.error('RESEND_API_KEY não configurada'); return; }
  const from = process.env.RESEND_FROM_EMAIL
    ? `RedaCheck <${process.env.RESEND_FROM_EMAIL}>`
    : 'RedaCheck <onboarding@resend.dev>';
  console.log(`[email] Enviando para: ${to} | De: ${from} | Assunto: ${subject}`);
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ from, to: [to], subject, html })
  });
  const data = await resp.json();
  if (!resp.ok) {
    console.error('[email] Resend retornou erro:', JSON.stringify(data));
    throw new Error('Resend erro: ' + JSON.stringify(data));
  }
  console.log('[email] Enviado com sucesso! ID:', data.id);
}

// ── CRIAR TABELAS ─────────────────────────────────────────────────────
async function inicializarBanco() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversas (
        id          BIGSERIAL PRIMARY KEY,
        usuario     TEXT NOT NULL DEFAULT 'Anônimo',
        mensagens   JSONB NOT NULL DEFAULT '[]',
        data_inicio TIMESTAMPTZ DEFAULT NOW(),
        duracao     INTEGER DEFAULT 0,
        status      TEXT DEFAULT 'novo',
        tags        JSONB DEFAULT '[]',
        nota_operador TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS feedbacks (
        id           BIGSERIAL PRIMARY KEY,
        usuario      TEXT NOT NULL DEFAULT 'Anônimo',
        nota         INTEGER DEFAULT 0,
        comentario   TEXT DEFAULT '',
        banca        TEXT DEFAULT 'ENEM',
        nota_redacao INTEGER DEFAULT 0,
        status       TEXT DEFAULT 'novo',
        aprovado     BOOLEAN DEFAULT FALSE,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sugestoes (
        id            BIGSERIAL PRIMARY KEY,
        usuario       TEXT NOT NULL DEFAULT 'Anônimo',
        texto         TEXT NOT NULL DEFAULT '',
        status        TEXT DEFAULT 'novo',
        nota_operador TEXT DEFAULT '',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS usuarios (
        id                     BIGSERIAL PRIMARY KEY,
        nome                   TEXT NOT NULL,
        email                  TEXT UNIQUE NOT NULL,
        senha_hash             TEXT NOT NULL DEFAULT '',
        codigo                 TEXT UNIQUE NOT NULL,
        banca                  TEXT DEFAULT 'ENEM',
        plano                  TEXT DEFAULT 'aluno',
        saldo                  NUMERIC(10,2) DEFAULT 0,
        total_redacoes         INTEGER DEFAULT 0,
        professor_status       TEXT DEFAULT 'nao',
        confirmado             BOOLEAN DEFAULT FALSE,
        codigo_confirmacao     TEXT,
        codigo_expira          TIMESTAMPTZ,
        whatsapp               TEXT,
        whatsapp_mkt           BOOLEAN DEFAULT FALSE,
        professor              TEXT DEFAULT 'nao',
        cnd_arquivo            TEXT,
        desconto_professor     BOOLEAN DEFAULT FALSE,
        avaliacoes_disponiveis INTEGER DEFAULT 0,
        codigo_indicante       TEXT,
        total_indicacoes       INTEGER DEFAULT 0,
        created_at             TIMESTAMPTZ DEFAULT NOW(),
        updated_at             TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS avaliacoes (
        id          BIGSERIAL PRIMARY KEY,
        usuario_id  BIGINT REFERENCES usuarios(id),
        usuario     TEXT NOT NULL,
        banca       TEXT DEFAULT 'ENEM',
        nota_geral  INTEGER DEFAULT 0,
        resultado   JSONB,
        redacao     TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS professores (
        id            BIGSERIAL PRIMARY KEY,
        usuario       TEXT NOT NULL,
        nivel         TEXT,
        disciplina    TEXT,
        instituicao   TEXT,
        arquivo_nome  TEXT,
        status        TEXT DEFAULT 'pendente',
        nota_operador TEXT DEFAULT '',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS solicitacoes_professor (
        id               BIGSERIAL PRIMARY KEY,
        usuario_id       BIGINT REFERENCES usuarios(id),
        usuario_nome     TEXT NOT NULL,
        usuario_email    TEXT NOT NULL,
        tipo_documento   TEXT NOT NULL DEFAULT 'CND',
        arquivo_nome     TEXT,
        arquivo_base64   TEXT,
        arquivo_mime     TEXT DEFAULT 'application/pdf',
        nivel            TEXT,
        disciplina       TEXT,
        instituicao      TEXT,
        status           TEXT DEFAULT 'pendente',
        nota_operador    TEXT DEFAULT '',
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sol_professor_status ON solicitacoes_professor(status);
      CREATE INDEX IF NOT EXISTS idx_sol_professor_usuario ON solicitacoes_professor(usuario_id);
      CREATE TABLE IF NOT EXISTS pagamentos (
        id             BIGSERIAL PRIMARY KEY,
        usuario_id     BIGINT REFERENCES usuarios(id),
        pacote         TEXT NOT NULL,
        avaliacoes     INTEGER NOT NULL,
        valor          NUMERIC(10,2) NOT NULL,
        status         TEXT DEFAULT 'pendente',
        preferencia_id TEXT,
        payment_id     TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pagamentos_usuario ON pagamentos(usuario_id);
      CREATE INDEX IF NOT EXISTS idx_pagamentos_status  ON pagamentos(status);
      CREATE INDEX IF NOT EXISTS idx_usuarios_codigo    ON usuarios(codigo);
      CREATE INDEX IF NOT EXISTS idx_usuarios_indicante ON usuarios(codigo_indicante);
      CREATE TABLE IF NOT EXISTS logs_usuario (
        id          BIGSERIAL PRIMARY KEY,
        usuario_id  BIGINT,
        email       TEXT,
        acao        TEXT NOT NULL,
        status      TEXT DEFAULT 'ok',
        detalhes    JSONB DEFAULT '{}',
        ip          TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_logs_usuario_id ON logs_usuario(usuario_id);
      CREATE INDEX IF NOT EXISTS idx_logs_acao       ON logs_usuario(acao);
      CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs_usuario(created_at DESC);
    `);

    // ── Migrações separadas (ALTER TABLE fora do bloco CREATE) ─────
    await client.query(`ALTER TABLE avaliacoes ADD COLUMN IF NOT EXISTS imagem_hash TEXT`).catch(() => {});
    await client.query(`ALTER TABLE avaliacoes ADD COLUMN IF NOT EXISTS possivel_ia BOOLEAN DEFAULT false`).catch(() => {});
    await client.query(`ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS aprovado BOOLEAN DEFAULT FALSE`).catch(() => {});
    await client.query(`ALTER TABLE sugestoes ADD COLUMN IF NOT EXISTS email TEXT`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_avaliacoes_imagem_hash ON avaliacoes(usuario_id, imagem_hash)`).catch(() => {});

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='senha_hash') THEN
          ALTER TABLE usuarios ADD COLUMN senha_hash TEXT NOT NULL DEFAULT '';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='confirmado') THEN
          ALTER TABLE usuarios ADD COLUMN confirmado BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='codigo_confirmacao') THEN
          ALTER TABLE usuarios ADD COLUMN codigo_confirmacao TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='codigo_expira') THEN
          ALTER TABLE usuarios ADD COLUMN codigo_expira TIMESTAMPTZ;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='whatsapp') THEN
          ALTER TABLE usuarios ADD COLUMN whatsapp TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='whatsapp_mkt') THEN
          ALTER TABLE usuarios ADD COLUMN whatsapp_mkt BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='professor') THEN
          ALTER TABLE usuarios ADD COLUMN professor TEXT DEFAULT 'nao';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='cnd_arquivo') THEN
          ALTER TABLE usuarios ADD COLUMN cnd_arquivo TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='desconto_professor') THEN
          ALTER TABLE usuarios ADD COLUMN desconto_professor BOOLEAN DEFAULT FALSE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='avaliacoes_disponiveis') THEN
          ALTER TABLE usuarios ADD COLUMN avaliacoes_disponiveis INTEGER DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='codigo_indicante') THEN
          ALTER TABLE usuarios ADD COLUMN codigo_indicante TEXT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='total_indicacoes') THEN
          ALTER TABLE usuarios ADD COLUMN total_indicacoes INTEGER DEFAULT 0;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='usuarios' AND column_name='escola') THEN
          ALTER TABLE usuarios ADD COLUMN escola TEXT;
        END IF;
      END $$;
    `).catch(e => console.error('[migration DO$$]', e.message));

    await client.query(`
      CREATE TABLE IF NOT EXISTS solicitacoes_professor (
        id               BIGSERIAL PRIMARY KEY,
        usuario_id       BIGINT,
        usuario_nome     TEXT NOT NULL DEFAULT '',
        usuario_email    TEXT NOT NULL DEFAULT '',
        tipo_documento   TEXT NOT NULL DEFAULT 'CND',
        arquivo_nome     TEXT,
        arquivo_base64   TEXT,
        arquivo_mime     TEXT DEFAULT 'application/pdf',
        nivel            TEXT,
        disciplina       TEXT,
        instituicao      TEXT,
        status           TEXT DEFAULT 'pendente',
        nota_operador    TEXT DEFAULT '',
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(e => console.warn('[migration sol_professor]', e.message));

    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE tablename='pagamentos' AND indexname='idx_pagamentos_preferencia_id'
        ) THEN
          ALTER TABLE pagamentos ADD CONSTRAINT idx_pagamentos_preferencia_id UNIQUE (preferencia_id);
        END IF;
      END $$;
    `).catch(() => {});

    console.log('✅ Banco de dados v9.2 inicializado!');
  } catch (err) {
    console.error('❌ Erro ao inicializar banco:', err.message);
  } finally {
    client.release();
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────
function gerarCodigo() {
  const rand = Math.floor(10000 + Math.random() * 90000);
  return 'RC-' + new Date().getFullYear() + '-' + rand;
}

function gerarCodigoConfirmacao() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function enviarEmailConfirmacao(email, nome, codigo) {
  const primeiroNome = nome.split(' ')[0];
  const ano = new Date().getFullYear();
  await enviarEmail(email, 'RedaCheck — Confirme seu cadastro', `
    <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#FAF9F7">
      <div style="text-align:center;margin-bottom:24px">
        <span style="font-size:22px;font-weight:700;letter-spacing:3px;color:#1A1A1A">REDA<span style="color:#C96A3A">CHECK</span></span>
        <div style="font-size:10px;color:#9B9080;letter-spacing:1.5px;margin-top:4px">MAIS QUE CORRIGIR — APERFEIÇOAR</div>
      </div>
      <h2 style="font-size:20px;color:#1A1A1A;margin-bottom:8px">Olá, ${primeiroNome}!</h2>
      <p style="font-size:14px;color:#6B6255;line-height:1.7;margin-bottom:24px">
        Bem-vindo ao RedaCheck! Para confirmar seu cadastro e ativar sua conta, insira o código abaixo na plataforma:
      </p>
      <div style="background:#1A1A1A;border-radius:16px;padding:24px;text-align:center;margin-bottom:24px">
        <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Seu código de confirmação</div>
        <div style="font-size:40px;font-weight:700;color:#FAF9F7;letter-spacing:8px">${codigo}</div>
        <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:10px">Válido por 15 minutos</div>
      </div>
      <p style="font-size:12px;color:#9B9080;line-height:1.6">Se você não criou uma conta no RedaCheck, ignore este e-mail.</p>

      <div style="background:#F5F2EE;border:1px solid #E5E0D8;border-radius:12px;padding:16px;margin-top:20px">
        <div style="font-size:11px;font-weight:700;color:#6B6255;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px">📋 Termos importantes</div>
        <p style="font-size:12px;color:#6B6255;line-height:1.7;margin:0">
          Ao usar o RedaCheck, você concorda que:<br><br>
          <strong style="color:#1A1A1A">1. Responsabilidade pelo conteúdo:</strong> O envio de textos gerados por inteligência artificial ou qualquer outra ferramenta automatizada é de <strong>exclusiva responsabilidade do usuário</strong>. O RedaCheck avalia o texto submetido independentemente de sua origem, e o crédito será debitado normalmente em todos os casos.<br><br>
          <strong style="color:#1A1A1A">2. Finalidade pedagógica:</strong> A plataforma é destinada ao aperfeiçoamento da escrita humana. O uso de textos gerados por IA contradiz essa finalidade, mas não isenta o usuário do débito.<br><br>
          <strong style="color:#1A1A1A">3. Termos completos:</strong> Os Termos de Uso e a Política de Privacidade completos estão disponíveis em <a href="https://redacheck.com.br" style="color:#C96A3A">redacheck.com.br</a>.
        </p>
      </div>

      <div style="border-top:1px solid #E5E0D8;margin-top:24px;padding-top:16px;text-align:center">
        <span style="font-size:11px;color:#9B9080">© ${ano} RedaCheck — redacheck.com.br</span>
      </div>
    </div>
  `);
}

// ── HELPERS DE CACHE ─────────────────────────────────────────────────
const crypto = require('crypto');

// SHA256 do base64 da imagem/PDF — para cache exato de foto/PDF
function hashBase64(b64) {
  return crypto.createHash('sha256').update(b64).digest('hex');
}


// ── STATUS ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'RedaCheck API v9.10 online',
    banco: 'PostgreSQL', versao: '9.2',
    auth: 'bcrypt+email', pagamento: 'MercadoPago',
    bonus: 'cadastro + indicacao (10/20 usuarios)',
    fix: 'webhook Pix: UPDATE por payment_id + logs rastreabilidade'
  });
});

// ══════════════════════════════════════════════════════════════════════
// AUTENTICAÇÃO
// ══════════════════════════════════════════════════════════════════════

app.post('/cadastro', async (req, res) => {
  try {
    const {
      nome, email, senha, banca, plano,
      escola, whatsapp, whatsapp_mkt, professor,
      cnd_base64, cnd_arquivo,
      codigo_indicante
    } = req.body;

    if (!nome || !email || !senha)
      return res.status(400).json({ erro: 'Nome, e-mail e senha são obrigatórios.' });
    if (senha.length < 6)
      return res.status(400).json({ erro: 'A senha deve ter no mínimo 6 caracteres.' });

    const existe = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (existe.rows.length > 0)
      return res.status(409).json({ erro: 'Este e-mail já está cadastrado. Faça login ou use outro e-mail.' });

    // Verificar WhatsApp duplicado — apenas se fornecido
    if (whatsapp && whatsapp.trim() !== '') {
      const wzCheck = await pool.query(
        'SELECT id FROM usuarios WHERE whatsapp = $1',
        [whatsapp.trim()]
      );
      if (wzCheck.rows.length > 0)
        return res.status(409).json({ erro: 'Este número de WhatsApp já está associado a outra conta.' });
    }

    let indicanteValido = null;
    if (codigo_indicante && codigo_indicante.trim()) {
      const indRes = await pool.query(
        'SELECT id FROM usuarios WHERE codigo = $1 AND confirmado = TRUE',
        [codigo_indicante.trim().toUpperCase()]
      );
      if (indRes.rows.length > 0) {
        indicanteValido = codigo_indicante.trim().toUpperCase();
      }
    }

    const senhaHash = await bcrypt.hash(senha, 12);
    const ehProfessor = (professor === 'pendente');
    const codigoUsuario = gerarCodigo();

    // Professor: conta bloqueada até aprovação master — sem código de confirmação
    // Aluno: código gerado imediatamente
    const codigoConfirmacao = ehProfessor ? null : gerarCodigoConfirmacao();
    const codigoExpira = ehProfessor ? null : new Date(Date.now() + 15 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO usuarios
         (nome, email, senha_hash, codigo, banca, plano, confirmado,
          codigo_confirmacao, codigo_expira, whatsapp, whatsapp_mkt,
          professor, cnd_arquivo)
       VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7,$8,$9,$10,$11,$12)
       RETURNING id, nome, email, codigo`,
      [
        nome, email.toLowerCase(), senhaHash, codigoUsuario,
        banca || 'ENEM', plano || 'aluno',
        codigoConfirmacao, codigoExpira,
        whatsapp || null, whatsapp_mkt || false,
        professor || 'nao', cnd_arquivo || null
      ]
    );

    if (escola && result.rows[0]?.id) {
      await pool.query(
        `UPDATE usuarios SET escola = $1 WHERE id = $2`,
        [escola, result.rows[0].id]
      ).catch(() => {});
    }

    if (indicanteValido && result.rows[0]?.id) {
      await pool.query(
        `UPDATE usuarios SET codigo_indicante = $1 WHERE id = $2`,
        [indicanteValido, result.rows[0].id]
      ).catch(e => console.warn('[cadastro] codigo_indicante não salvo:', e.message));
    }

    // ── PROFESSOR: inserir em solicitacoes_professor + log ────────────
    if (ehProfessor && result.rows[0]?.id) {
      try {
        // Verificar se já existe solicitação pendente (segurança extra)
        const solExiste = await pool.query(
          `SELECT id FROM solicitacoes_professor WHERE usuario_id = $1 AND status = 'pendente'`,
          [result.rows[0].id]
        );
        if (solExiste.rows.length === 0) {
          // Detectar MIME pelo nome do arquivo
          const nomeArq = cnd_arquivo || 'documento';
          const mimeDetectado = nomeArq.toLowerCase().endsWith('.pdf') ? 'application/pdf'
            : nomeArq.toLowerCase().endsWith('.png') ? 'image/png'
            : nomeArq.toLowerCase().endsWith('.jpg') || nomeArq.toLowerCase().endsWith('.jpeg') ? 'image/jpeg'
            : nomeArq.toLowerCase().endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : nomeArq.toLowerCase().endsWith('.doc') ? 'application/msword'
            : 'application/pdf';
          await pool.query(
            `INSERT INTO solicitacoes_professor
               (usuario_id, usuario_nome, usuario_email, tipo_documento,
                arquivo_nome, arquivo_base64, arquivo_mime)
             VALUES ($1,$2,$3,'CND',$4,$5,$6)`,
            [result.rows[0].id, nome, email.toLowerCase(),
             nomeArq, cnd_base64 || '', mimeDetectado]
          );
        }
        await log(result.rows[0].id, email, 'cadastro_professor', 'ok',
          { status: 'aguardando_aprovacao_master' });
        console.log(`[cadastro] Professor cadastrado aguardando aprovação: ${email}`);
      } catch (solErr) {
        console.error('[cadastro] Erro ao registrar solicitação professor:', solErr.message);
      }

      return res.json({
        ok: true,
        professor_pendente: true,
        mensagem: 'Cadastro recebido! Seu documento está em análise. Você receberá um e-mail quando sua conta for aprovada.',
        usuario: result.rows[0]
      });
    }

    // ── ALUNO: enviar e-mail de confirmação normalmente ───────────────
    try {
      await enviarEmailConfirmacao(email, nome, codigoConfirmacao);
      console.log('[cadastro] E-mail enviado para:', email);
    } catch (emailErr) {
      console.error('[cadastro] FALHA e-mail:', emailErr.message);
    }

    res.json({
      ok: true,
      mensagem: 'Cadastro realizado! Verifique seu e-mail e insira o código de confirmação.',
      usuario: result.rows[0]
    });

  } catch (err) {
    console.error('Erro no cadastro:', err.message);
    res.status(500).json({ erro: 'Erro ao realizar cadastro.' });
  }
});

app.post('/confirmar', async (req, res) => {
  try {
    const { email, codigo } = req.body;
    if (!email || !codigo)
      return res.status(400).json({ erro: 'E-mail e código são obrigatórios.' });

    const result = await pool.query(
      `SELECT id, nome, email, codigo, banca, plano, confirmado,
              codigo_confirmacao, codigo_expira, codigo_indicante,
              avaliacoes_disponiveis, total_indicacoes
       FROM usuarios WHERE email = $1`,
      [email.toLowerCase()]
    );
    if (!result.rows.length)
      return res.status(404).json({ erro: 'E-mail não encontrado.' });

    const usuario = result.rows[0];

    if (usuario.confirmado) {
      return res.json({
        ok: true,
        mensagem: 'Conta já confirmada.',
        usuario: {
          id: usuario.id, nome: usuario.nome, email: usuario.email,
          codigo: usuario.codigo, banca: usuario.banca, plano: usuario.plano,
          avaliacoes_disponiveis: usuario.avaliacoes_disponiveis || 0,
          total_indicacoes: usuario.total_indicacoes || 0
        }
      });
    }

    if (usuario.codigo_confirmacao !== codigo)
      return res.status(400).json({ erro: 'Código incorreto. Verifique e tente novamente.' });
    if (new Date() > new Date(usuario.codigo_expira))
      return res.status(400).json({ erro: 'Código expirado. Solicite um novo código.' });

    const ehProfessorAprovado = usuario.professor === 'aprovado';

    await pool.query(
      `UPDATE usuarios
       SET confirmado = TRUE,
           codigo_confirmacao = NULL,
           codigo_expira = NULL,
           avaliacoes_disponiveis = COALESCE(avaliacoes_disponiveis, 0) + 1,
           updated_at = NOW()
       WHERE email = $1`,
      [email.toLowerCase()]
    );

    if (ehProfessorAprovado) {
      await log(usuario.id, email, 'professor_conta_ativada', 'ok', { bonus: 1 });
    } else {
      await log(usuario.id, email, 'confirmacao_email', 'ok', { bonus_boas_vindas: 1 });
    }
    await log(usuario.id, email, 'credito', 'ok', { origem: ehProfessorAprovado ? 'bonus_professor_ativacao' : 'bonus_cadastro', qtd: 1, saldo_antes: usuario.avaliacoes_disponiveis || 0, saldo_depois: (usuario.avaliacoes_disponiveis || 0) + 1 });

    if (usuario.codigo_indicante) {
      try {
        const updInd = await pool.query(
          `UPDATE usuarios
           SET total_indicacoes = COALESCE(total_indicacoes, 0) + 1,
               updated_at = NOW()
           WHERE codigo = $1 AND confirmado = TRUE
           RETURNING id, total_indicacoes`,
          [usuario.codigo_indicante]
        );

        if (updInd.rows.length > 0) {
          const novoTotal = updInd.rows[0].total_indicacoes;
          const indicanteId = updInd.rows[0].id;
          if (novoTotal === 10 || novoTotal === 20) {
            await pool.query(
              `UPDATE usuarios
               SET avaliacoes_disponiveis = COALESCE(avaliacoes_disponiveis, 0) + 1,
                   updated_at = NOW()
               WHERE id = $1`,
              [indicanteId]
            );
            console.log(`[indicacao] Bônus creditado ao indicante id=${indicanteId}, total_indicacoes=${novoTotal}`);
            await log(indicanteId, null, 'credito', 'ok', { origem: 'bonus_indicacao', indicacao_numero: novoTotal, qtd: 1, indicado_email: email });
          }
        }
      } catch (indErr) {
        console.error('[indicacao] Erro:', indErr.message);
      }
    }

    const atualizado = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    const u = atualizado.rows[0];

    const msgConfirmacao = ehProfessorAprovado
      ? 'Conta ativada! Bem-vindo ao RedaCheck Professor. Seu desconto de 50% já está ativo!'
      : 'E-mail confirmado! Bem-vindo ao RedaCheck. Você ganhou 1 avaliação bônus!';

    res.json({
      ok: true,
      mensagem: msgConfirmacao,
      professor_ativado: ehProfessorAprovado,
      usuario: {
        id: u.id, nome: u.nome, email: u.email,
        codigo: u.codigo, banca: u.banca, plano: u.plano,
        avaliacoes_disponiveis: u.avaliacoes_disponiveis || 0,
        total_indicacoes: u.total_indicacoes || 0
      }
    });

  } catch (err) {
    console.error('Erro na confirmação:', err.message);
    res.status(500).json({ erro: 'Erro ao confirmar e-mail.' });
  }
});

app.post('/reenviar-codigo', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ erro: 'E-mail obrigatório.' });
    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(404).json({ erro: 'E-mail não encontrado.' });
    const usuario = result.rows[0];
    // Professor pendente não pode reenviar código — aguarda aprovação master
    if (usuario.professor === 'pendente') {
      return res.status(403).json({
        erro: 'Seu cadastro está em análise pelo operador. Aguarde o e-mail de aprovação.',
        professor_pendente: true
      });
    }
    if (usuario.confirmado) return res.json({ ok: true, mensagem: 'Conta já confirmada.' });
    const novoCodigo = gerarCodigoConfirmacao();
    const novaExpiracao = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      'UPDATE usuarios SET codigo_confirmacao = $1, codigo_expira = $2 WHERE email = $3',
      [novoCodigo, novaExpiracao, email.toLowerCase()]
    );
    await enviarEmailConfirmacao(email, usuario.nome, novoCodigo);
    res.json({ ok: true, mensagem: 'Novo código enviado para seu e-mail.' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao reenviar código.' });
  }
});

app.post('/recuperar-senha', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ erro: 'E-mail obrigatório.' });
    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length)
      return res.status(404).json({ erro: 'E-mail não encontrado. Verifique e tente novamente.' });
    const codigo = gerarCodigoConfirmacao();
    const expira = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query(
      'UPDATE usuarios SET codigo_confirmacao = $1, codigo_expira = $2 WHERE email = $3',
      [codigo, expira, email.toLowerCase()]
    );
    const ano = new Date().getFullYear();
    await enviarEmail(email, 'RedaCheck — Redefinição de senha', `
      <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#FAF9F7">
        <div style="text-align:center;margin-bottom:24px">
          <span style="font-size:22px;font-weight:700;letter-spacing:3px;color:#1A1A1A">REDA<span style="color:#C96A3A">CHECK</span></span>
          <div style="font-size:10px;color:#9B9080;letter-spacing:1.5px;margin-top:4px">MAIS QUE CORRIGIR — APERFEIÇOAR</div>
        </div>
        <h2 style="font-size:20px;color:#1A1A1A;margin-bottom:8px">Redefinição de senha</h2>
        <p style="font-size:14px;color:#6B6255;line-height:1.7;margin-bottom:24px">
          Recebemos uma solicitação para redefinir a senha da conta <strong>${email}</strong>. Use o código abaixo:
        </p>
        <div style="background:#1A1A1A;border-radius:16px;padding:24px;text-align:center;margin-bottom:24px">
          <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Código de redefinição</div>
          <div style="font-size:40px;font-weight:700;color:#FAF9F7;letter-spacing:8px">${codigo}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:10px">Válido por 15 minutos</div>
        </div>
        <p style="font-size:12px;color:#9B9080;line-height:1.6">Se você não solicitou a redefinição, ignore este e-mail.</p>
        <div style="border-top:1px solid #E5E0D8;margin-top:24px;padding-top:16px;text-align:center">
          <span style="font-size:11px;color:#9B9080">© ${ano} RedaCheck — redacheck.com.br</span>
        </div>
      </div>
    `);
    res.json({ ok: true, mensagem: 'Código enviado para seu e-mail.' });
  } catch (err) {
    console.error('Erro na recuperação:', err.message);
    res.status(500).json({ erro: 'Erro ao processar recuperação.' });
  }
});

app.post('/redefinir-senha', async (req, res) => {
  try {
    const { email, codigo, novaSenha } = req.body;
    if (!email || !codigo || !novaSenha) return res.status(400).json({ erro: 'Dados incompletos.' });
    if (novaSenha.length < 6) return res.status(400).json({ erro: 'A senha deve ter no mínimo 6 caracteres.' });
    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(404).json({ erro: 'E-mail não encontrado.' });
    const usuario = result.rows[0];
    if (usuario.codigo_confirmacao !== codigo)
      return res.status(400).json({ erro: 'Código incorreto. Verifique e tente novamente.' });
    if (new Date() > new Date(usuario.codigo_expira))
      return res.status(400).json({ erro: 'Código expirado. Solicite um novo código.' });
    const novaSenhaHash = await bcrypt.hash(novaSenha, 12);
    await pool.query(
      'UPDATE usuarios SET senha_hash = $1, codigo_confirmacao = NULL, codigo_expira = NULL, confirmado = TRUE, updated_at = NOW() WHERE email = $2',
      [novaSenhaHash, email.toLowerCase()]
    );
    res.json({ ok: true, mensagem: 'Senha redefinida com sucesso.' });
  } catch (err) {
    console.error('Erro ao redefinir senha:', err.message);
    res.status(500).json({ erro: 'Erro ao redefinir senha.' });
  }
});

const _loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now(), windowMs = 15*60*1000, maxAttempts = 10;
  const entry = _loginAttempts.get(ip);
  if (entry) {
    entry.times = entry.times.filter(t => now - t < windowMs);
    if (entry.times.length >= maxAttempts) {
      const restMin = Math.ceil((windowMs - (now - entry.times[0])) / 60000);
      return res.status(429).json({ erro: `Muitas tentativas. Tente em ${restMin} minuto(s).` });
    }
    entry.times.push(now);
  } else { _loginAttempts.set(ip, { times: [now] }); }
  next();
}

app.post('/login', loginRateLimit, async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'E-mail e senha são obrigatórios.' });
    const result = await pool.query(
      `SELECT id, nome, email, senha_hash, codigo, banca, plano, saldo,
              total_redacoes, avaliacoes_disponiveis, desconto_professor,
              professor, total_indicacoes, confirmado
       FROM usuarios WHERE email = $1`,
      [email.toLowerCase()]
    );
    if (!result.rows.length) return res.status(401).json({ erro: 'E-mail não cadastrado.' });
    const usuario = result.rows[0];
    const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);
    if (!senhaCorreta) {
      await log(usuario.id, email, 'login', 'erro', { motivo: 'senha_incorreta' }, req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress);
      return res.status(401).json({ erro: 'Senha incorreta.' });
    }
    // Professor pendente — bloqueado até aprovação master
    if (usuario.professor === 'pendente') {
      await log(usuario.id, email, 'login', 'erro', { motivo: 'professor_pendente' }, req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress);
      return res.status(403).json({
        erro: 'Seu cadastro de professor está em análise. Você receberá um e-mail quando for aprovado.',
        professor_pendente: true
      });
    }
    if (!usuario.confirmado) {
      await log(usuario.id, email, 'login', 'erro', { motivo: 'conta_nao_confirmada' }, req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress);
      return res.status(403).json({ erro: 'Conta não confirmada.', precisaConfirmar: true, email: usuario.email });
    }
    await log(usuario.id, email, 'login', 'ok', {}, req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress);
    res.json({
      ok: true,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        codigo: usuario.codigo,
        banca: usuario.banca,
        plano: usuario.plano,
        saldo: parseFloat(usuario.saldo),
        total_redacoes: usuario.total_redacoes,
        avaliacoes_disponiveis: usuario.avaliacoes_disponiveis || 0,
        desconto_professor: usuario.desconto_professor || false,
        professor: usuario.professor || 'nao',
        total_indicacoes: usuario.total_indicacoes || 0
      }
    });
  } catch (err) {
    console.error('Erro no login:', err.message);
    res.status(500).json({ erro: 'Erro ao realizar login.' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// PROMPTS DAS BANCAS
// ══════════════════════════════════════════════════════════════════════

const PROMPT_BASE = `Você é o RedaCheck, o mais rigoroso e preciso avaliador de redações dissertativas do Brasil. Sua análise é sempre fundamentada nas seguintes fontes:

GRAMÁTICAS DE BASE:
[A] CEGALLA, Domingos Paschoal. Novíssima Gramática da Língua Portuguesa. São Paulo: Nacional.
[B] CUNHA, Celso; CINTRA, Lindley. Nova Gramática do Português Contemporâneo. 7ª ed. Rio de Janeiro: Lexikon, 2016.
[I] CUNHA, Celso. Gramática Essencial da Língua Portuguesa. Rio de Janeiro: Nova Fronteira.

DICIONÁRIOS E VOCABULÁRIOS:
[C] Aulete Digital: https://aulete.com.br/wap/
[D] DLP/ABL: servbib.academia.org.br/dlp
[E] VOLP/ABL: www.academia.org.br/nossa-lingua/busca-no-vocabulario

LINGUÍSTICA TEXTUAL E TEORIA DOS GÊNEROS:
[F] MARCUSCHI, Luiz Antônio. Gêneros Textuais: definição e funcionalidade. In: DIONÍSIO, A. P. et al. (orgs.). Gêneros Textuais e Ensino. Rio de Janeiro: Lucerna, 2002.
[G] MARCUSCHI, Luiz Antônio. Produção Textual, Análise de Gêneros e Compreensão. São Paulo: Parábola Editorial, 2008.
[H] ANTUNES, Irandé. Língua, Texto e Ensino: outra escola possível. São Paulo: Parábola Editorial, 2009.

FUNDAMENTO FILOSÓFICO-PEDAGÓGICO:
[I] FREIRE, Paulo. A Importância do Ato de Ler: em três artigos que se completam. São Paulo: Autores Associados/Cortez, 1989.
    Princípio central: "A leitura do mundo precede a leitura da palavra" — antes de avaliar a gramática, avalia-se se o texto expressa um pensamento coerente sobre o mundo.
    Implicações para avaliação: (a) a escrita é um ato criador e político, não mecânico; (b) o erro gramatical não anula o pensamento — deve ser apontado com respeito e orientação; (c) o feedback deve ser dialógico, não sentenciador.

DOCUMENTOS NORMATIVOS DO MINISTÉRIO DA EDUCAÇÃO:
[J] BRASIL. Base Nacional Comum Curricular (BNCC). Área de Linguagens e suas Tecnologias — Língua Portuguesa no Ensino Médio. Brasília: MEC, 2018.
    Competências e habilidades centrais: EM13LP01 a EM13LP28.
    Eixos organizadores: Leitura, Produção Textual, Oralidade, Análise Linguística e Semiótica.
    Campos de atuação: artístico-literário, jornalístico-midiático, práticas de estudo e pesquisa, atuação na vida pública.
[K] BRASIL. Parâmetros Curriculares Nacionais — Língua Portuguesa — Ensino Médio. Brasília: MEC, 1998/2000.
    Eixos organizadores: uso da língua em situações comunicativas reais, reflexão sobre a língua e a linguagem, leitura de textos de diferentes gêneros e esferas discursivas.

ALINHAMENTO BNCC × ENEM:
- A Cartilha do ENEM e a BNCC são documentos do mesmo ministério e compartilham a mesma filosofia pedagógica.
- C1 (domínio da norma culta) alinha-se às habilidades EM13LP06, EM13LP07 (análise linguística, norma-padrão).
- C2 (repertório sociocultural) alinha-se às habilidades EM13LP02, EM13LP03 (leitura crítica, intertextualidade).
- C3 (organização argumentativa) alinha-se às habilidades EM13LP15, EM13LP16 (produção textual, argumentação).
- C4 (coesão textual) alinha-se às habilidades EM13LP08, EM13LP09 (coesão, coerência, progressão temática).
- C5 (proposta de intervenção) alinha-se às habilidades EM13LP20, EM13LP21 (participação cidadã, práticas de vida pública).

OS 10 EIXOS DE ANÁLISE:

EIXO 1 — CRASE: [A] Cegalla pp.275–284
EIXO 2 — CONCORDÂNCIA VERBAL E NOMINAL: [A] Cegalla pp.438–472
EIXO 3 — PONTUAÇÃO: [A] Cegalla pp.428–435
EIXO 4 — REGÊNCIA VERBAL E NOMINAL: [A] Cegalla pp.483–515
EIXO 5 — ACENTUAÇÃO E ORTOGRAFIA: [E] VOLP/ABL
EIXO 6 — MAIÚSCULAS E HÍFEN: [A] Cegalla pp.52–75
EIXO 7 — COLOCAÇÃO PRONOMINAL: [A] Cegalla pp.538–545
EIXO 8 — COESÃO TEXTUAL: Analise os mecanismos de coesão referencial (pronomes, substituição lexical, elipse) e coesão sequencial (conectivos, operadores argumentativos). Fundamento: [G] Marcuschi cap. 1.10.1; [H] Antunes cap. 4–5; [J] BNCC EM13LP08, EM13LP09.
EIXO 9 — COERÊNCIA E TEXTUALIDADE: Avalie os 7 critérios de Beaugrande & Dressler — coesão, coerência, intencionalidade, aceitabilidade, situacionalidade, informatividade e intertextualidade. Fundamento: [G] Marcuschi cap. 1.10–1.11; [H] Antunes cap. 5–6; [J] BNCC EM13LP02, EM13LP03; [K] PCNs — Leitura e produção de sentidos.
EIXO 10 — ADEQUAÇÃO AO GÊNERO DISCURSIVO: Verifique se o texto respeita as características sociocomunicativas do gênero solicitado (tipo textual, finalidade, interlocutores, suporte). Fundamento: [F] Marcuschi; [G] Marcuschi cap. 1.8; [J] BNCC EM13LP14, EM13LP15 (produção textual em diferentes gêneros); [K] PCNs — Gêneros e esferas discursivas.

REGRAS INVIOLÁVEIS:
- Nunca use a Wikipedia como referência
- Sempre cite obra e, quando possível, página ao referenciar gramática ou teoria
- Nunca invente citações ou referências bibliográficas
- Mantenha tom pedagógico, rigoroso e construtivo
- Nos campos "referencia" do JSON, cite sempre pelo código [A]–[I] e o conceito aplicado

IMPORTANTE:
- Avalie o texto apresentado com rigor e imparcialidade
- Para aproveitar ao máximo o RedaCheck, recomenda-se o envio de redações originais

ORIENTAÇÃO PEDAGÓGICA PARA TEXTOS COM DESVIOS DE GÊNERO:
O RedaCheck é uma plataforma pedagógica. Diante de qualquer texto enviado — seja ele
uma receita, uma lista, uma narrativa, um texto sem nexo ou com baixa densidade argumentativa —
sua função é SEMPRE orientar, nunca apenas punir.

Se identificar que o texto apresenta baixa densidade dissertativa:
  • Vocabulário restrito, repetitivo ou coloquial em excesso
  • Ausência de conectivos argumentativos e operadores lógicos
  • Ausência de repertório sociocultural pertinente
  • Estrutura sem tese, desenvolvimento ou conclusão reconhecíveis
  • Gênero claramente diferente do dissertativo-argumentativo

PROCEDA DA SEGUINTE FORMA:
  1. Avalie o que há de aproveitável — nunca ignore o esforço do estudante
  2. Penalize C2 (compreensão da proposta) e C3 (argumentação) de forma proporcional ao desvio
  3. No comentarioGeral, explique com clareza e gentileza o que foi identificado
  4. Oriente como o estudante pode transformar aquele texto em uma dissertação
  5. Encerre sempre com encorajamento — o erro é parte do aprendizado

LEMBRE-SE: não somos a banca do ENEM nem de nenhum concurso.
Somos um instrumento de formação. Nossa nota não elimina ninguém —
ela mostra o caminho para quem quer evoluir.`;

const PROMPT_ENEM = `${PROMPT_BASE}

CRITÉRIOS ENEM 2025 — 5 COMPETÊNCIAS:
C1 (0–200): 200=excelente domínio; 160=bom; 120=mediano; 80=insuficiente; 40=precário; 0=desconhecimento
C2 (0–200): 200=argumentação consistente+repertório produtivo; 160=bom; 120=previsível; 80=cópia/insuficiente; 40=tangenciamento; 0=fuga
C3 (0–200): 200=consistente+autoria; 160=organizada+indícios autoria; 120=limitada+pouco organizada; 80=desorganizada; 40=pouco relacionada; 0=não relacionada
C4 (0–200): 200=articula bem+repertório diversificado; 160=poucas inadequações; 120=mediana+inadequações; 80=insuficiente; 40=precária; 0=não articula
C5 (0–200): 200=muito bem elaborada+detalhada; 160=bem elaborada; 120=mediana; 80=insuficiente; 40=vaga; 0=ausente/desrespeita DH
C5 OBRIGATÓRIO — 5 elementos: agente + ação + modo/meio + finalidade + efeito esperado`;


const SCHEMA_JSON = `
RESPONDA EXCLUSIVAMENTE COM JSON VÁLIDO, sem texto antes ou depois, sem markdown, sem backticks:
{
  "notaGeral": <0-1000>,
  "nivel": "<string>",
  "banca": "<string>",
  "competencias": [{"codigo":"C1","descricao":"<string>","nota":<int>,"notaMaxima":200,"percentual":<0-100>,"justificativa":"<string>"}],
  "paragrafos": [{"numero":<int>,"titulo":"<string>","classificacao":"BOM|REGULAR|ATENÇÃO","texto_trecho":"<string>","recursosCoesivos":"<string>","estruturaArgumentativa":"<string>","desvios":"<string>","sugestao":"<string>","referencia":"<string>"}],
  "pontosFortes": [{"descricao":"<string>","referencia":"<string>"}],
  "desviosIdentificados": [{"eixo":"<string>","trecho":"<string>","correcao":"<string>","explicacao":"<string>","referencia":"<string>"}],
  "comentarioGeral": "<string>",
  "assinatura": "Avaliação fundamentada nos critérios do INEP/ENEM, nas gramáticas de Cegalla, Celso Cunha & Cintra, na teoria dos gêneros textuais de Marcuschi, na linguística textual de Irandé Antunes e nos dicionários Aulete, DLP/ABL e VOLP/ABL."
}`

// ── PROMPT UnB (Vestibular) ─────────────────────────────────────────
const PROMPT_UNB = `${PROMPT_BASE}

BANCA: UnB — Vestibular da Universidade de Brasília
CRITÉRIOS OFICIAIS (Edital UnB):

DOMÍNIO DO CONTEÚDO (NC) — máximo 10,00 pontos:
  • Apresentação textual (clareza, objetividade, legibilidade da escrita): até 3,0 pts
  • Estrutura textual (introdução, desenvolvimento, conclusão articulados): até 3,0 pts
  • Desenvolvimento do tema (pertinência, profundidade, coerência argumentativa): até 4,0 pts

DOMÍNIO DA MODALIDADE ESCRITA (NE):
  Contabilize cada erro individualmente nas categorias:
  • Ortografia: grafia incorreta de palavras, acentuação, hífen
  • Morfossintaxe: concordância verbal/nominal, regência, colocação pronominal, conjugação
  • Propriedade vocabular: uso inadequado, ambiguidade, imprecisão lexical

FÓRMULA OFICIAL UnB: NR = NC – 2 × (NE ÷ TL)
  Onde TL = total de linhas efetivamente escritas
  Nota mínima: 0,000 | Nota máxima: 10,000
  Eliminação: NR < 4,000

CONVERSÃO PARA ESCALA 0–1000:
  • NR 0,0 a 4,0 → 0 a 700 (abaixo da média — seria eliminado)
  • NR 4,0 a 7,0 → 700 a 900 (aprovado — regular a bom)
  • NR 7,0 a 10,0 → 900 a 1000 (aprovado — excelente, critérios rígidos)

ATENÇÃO: aplique rigor normativo. O fator 2 na fórmula penaliza erros proporcionalmente ao texto.
Informe no campo "notaGeral" a nota já convertida para escala 0–1000.
Informe no campo "formulaDetalhada" os valores NC, NE e TL utilizados.
` + SCHEMA_JSON;

// ── PROMPT CEBRASPE (Concurso Público) ──────────────────────────────
const PROMPT_CEBRASPE = `${PROMPT_BASE}

BANCA: CEBRASPE — Concurso Público (vinculada à UnB)
CRITÉRIOS OFICIAIS (Edital CEBRASPE):

DOMÍNIO DO CONTEÚDO (NC) — máximo 30,00 pontos:
  • Apresentação textual (clareza, objetividade, coerência global): até 8,0 pts
  • Estrutura textual (organização do texto dissertativo, articulação entre partes): até 8,0 pts
  • Desenvolvimento do tema (pertinência ao tema proposto, profundidade argumentativa,
    uso adequado de repertório, proposta de intervenção quando exigida): até 14,0 pts

DOMÍNIO DA MODALIDADE ESCRITA (NE) — CRITÉRIO ELIMINATÓRIO:
  Contabilize CADA erro individualmente com MÁXIMO RIGOR:
  • Grafia: ortografia, acentuação gráfica, hífen, uso de maiúsculas
  • Morfossintaxe: concordância verbal e nominal, regência verbal e nominal,
    colocação pronominal, uso de tempos e modos verbais, paralelismo sintático
  • Propriedade vocabular: inadequação lexical, ambiguidade, pleonasmo vicioso,
    cacofonia, barbarismo, solecismo

FÓRMULA OFICIAL CEBRASPE: NPD = NC – 6 × (NE ÷ TL)
  Onde TL = total de linhas efetivamente escritas (máximo 30 linhas)
  Nota mínima: 0,000 | Nota máxima: 30,000
  Eliminação: NPD < 15,000
  ATENÇÃO: fator 6 — cada erro tem impacto 3x maior que no vestibular UnB

CONVERSÃO PARA ESCALA 0–1000:
  • NPD 0 a 15,0 → 0 a 700 (abaixo da média — seria eliminado no concurso)
  • NPD 15,0 a 24,0 → 700 a 900 (aprovado — regular a bom)
  • NPD 24,0 a 30,0 → 900 a 1000 (aprovado — excelente, critérios rígidos)

ATENÇÃO MÁXIMA: o texto dissertativo para concurso CEBRASPE exige:
  - Linguagem formal e objetiva ao longo de todo o texto
  - Argumentação fundamentada em conhecimentos específicos do tema
  - Coesão e coerência rigorosas entre parágrafos
  - Ausência de marcas de identificação do candidato
  - Respeito ao limite de linhas (até 30 linhas)
Informe no campo "notaGeral" a nota já convertida para escala 0–1000.
Informe no campo "formulaDetalhada" os valores NC, NE e TL utilizados.
` + SCHEMA_JSON;


;

// ── ROTA DE AVALIAÇÃO ─────────────────────────────────────────────────

const PROMPTS = {
  ENEM: PROMPT_ENEM,
  ITA: `${PROMPT_BASE}\nCRITÉRIOS ITA: 4 critérios — desenvolvimento do tema (0–30), argumentação (0–30), domínio da língua (0–25), coesão e coerência (0–15). Total 0–100, escalar para 0–1000.`,
  UNICAMP: `${PROMPT_BASE}\nCRITÉRIOS UNICAMP: proposta temática (0–4), gênero discursivo (0–4), norma culta (0–4). Total 0–12. Atenção especial ao Eixo 10 — adequação ao gênero discursivo é critério central na Unicamp [F][G].`,
  FUVEST: `${PROMPT_BASE}\nCRITÉRIOS FUVEST: cumprimento da proposta (0–5), desenvolvimento (0–5), domínio da língua (0–5), coesão (0–5). Total 0–20, escalar para 0–100. Use os Eixos 8 e 9 para avaliar coesão e coerência com fundamentação em [G][H].`,
  CONCURSO_PUBLICO: `${PROMPT_BASE}\nCRITÉRIOS CONCURSO: adequação ao tema (0–30), argumentação (0–30), domínio da norma culta (0–25), coesão (0–15). Total 0–100. Aplique todos os 10 eixos com rigor normativo.`,
  UNB: PROMPT_UNB,
  CEBRASPE: PROMPT_CEBRASPE
};


// ── WINSTON AI — detecção de texto gerado por IA ──────────────────────
// Retorna score 0-1 (probabilidade de ser IA) ou null em caso de falha
// Não bloqueia — apenas informa. Timeout: 5s para não atrasar avaliação
async function winstonDetect(texto) {
  try {
    const key = process.env.WINSTON_API_KEY;
    if (!key || !texto || texto.trim().length < 50) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch('https://api.gowinston.ai/v2/ai-content-detection', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({ text: texto.trim().substring(0, 4000), language: 'pt', sentences: false }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      console.warn('[Winston] Resposta não OK:', resp.status, await resp.text().catch(()=>''));
      return null;
    }
    const data = await resp.json();
    console.log('[Winston] Resposta:', JSON.stringify(data).substring(0, 200));
    // Winston retorna "score" = Human Score (0=IA pura, 100=humano puro)
    // Convertemos para probabilidade de IA: ia_score = 1 - (humanScore/100)
    const humanScore = data?.score ?? data?.result?.score ?? data?.human_score ?? null;
    if (humanScore === null) return null;
    const iaScore = 1 - (humanScore / 100);
    return iaScore; // 0=humano, 1=IA
  } catch(e) {
    console.warn('[Winston] Erro:', e.message);
    return null; // Falha silenciosa — não afeta a avaliação
  }
}

app.post('/avaliar', async (req, res) => {
  try {
    const { redacao, banca, tipoProva, usuario, imagem, mediaType, usuarioId } = req.body;

    const temImagem = imagem && imagem.length > 100;
    if (!temImagem && (!redacao || redacao.trim().length < 50))
      return res.status(400).json({ erro: 'Redação não enviada ou muito curta (mínimo 50 caracteres).' });

    const bancaNorm = (banca || tipoProva || 'ENEM').toUpperCase().replace(/ /g, '_');
    const promptSistema = PROMPTS[bancaNorm] || PROMPTS['ENEM'];
    const bancaFinal = PROMPTS[bancaNorm] ? bancaNorm : 'ENEM';

    const MIME_VALIDOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const mimeRaw = mediaType || 'image/jpeg';

    if (temImagem && mimeRaw === 'application/pdf') {
      return res.status(400).json({
        erro: 'PDF escaneado não é suportado. Use o modo Foto (JPG/PNG) para redações manuscritas, ou modo Arquivo para PDFs com texto selecionável.'
      });
    }

    const mimeFinal = MIME_VALIDOS.includes(mimeRaw) ? mimeRaw : 'image/jpeg';

    if (temImagem && imagem.length > 6_000_000)
      return res.status(400).json({ erro: 'Imagem muito grande. Reduza a resolução e tente novamente.' });

    let mensagemConteudo;
    if (temImagem) {
      mensagemConteudo = [
        { type: 'image', source: { type: 'base64', media_type: mimeFinal, data: imagem } },
        {
          type: 'text',
          text: `${promptSistema}\n${SCHEMA_JSON}\n\nAnalise a imagem acima. Ela contém uma redação manuscrita. Transcreva mentalmente o texto e avalie para a banca ${bancaFinal}. Se a imagem estiver ilegível, informe no campo "comentarioGeral".`
        }
      ];
    } else {
      mensagemConteudo = `${promptSistema}\n${SCHEMA_JSON}\n\nAvalie para a banca ${bancaFinal}:\n\nREDAÇÃO:\n${redacao}`;
    }

    console.log(`[/avaliar] modo=${temImagem?'foto':'texto'} banca=${bancaFinal} usuario=${usuario||'?'} mime=${mimeFinal} tam=${temImagem?imagem.length:redacao?.length}`);

    if (!usuarioId) return res.status(401).json({ erro: 'É necessário estar logado para enviar uma redação.' });

    // Garantir usuarioIdFinal antes do débito — previne INSERT null
    let _uidPreDebito = usuarioId;
    if (!_uidPreDebito) {
      return res.status(401).json({ erro: 'Identificação do usuário não encontrada. Faça login novamente.' });
    }

    // ══════════════════════════════════════════════════════════════════
    // CACHE v9.3 — 3 camadas
    // Camada A: foto/PDF — hash SHA256 exato → retorna sem cobrar
    // Camada B: texto idêntico — fingerprint exato → retorna sem cobrar
    // Camada C: texto similar (Jaccard ≥ 0.82) → pergunta ao usuário
    // ══════════════════════════════════════════════════════════════════

    // ── CAMADA A: foto/PDF — hash SHA256 ─────────────────────────────
    if (temImagem && imagem && imagem.length > 100) {
      const imgHash = hashBase64(imagem);
      // Verificar saldo antes do cache — se saldo=0, bypass (cobra e reavalia)
      const saldoCheckA = await pool.query('SELECT avaliacoes_disponiveis FROM usuarios WHERE id = $1', [usuarioId]);
      const saldoAtualA = saldoCheckA.rows[0]?.avaliacoes_disponiveis || 0;

      if (saldoAtualA > 0) {
        const cachedImg = await pool.query(
          `SELECT id, resultado, nota_geral, banca, created_at
           FROM avaliacoes
           WHERE usuario_id = $1 AND imagem_hash = $2 AND banca = $3
           ORDER BY created_at DESC LIMIT 1`,
          [usuarioId, imgHash, bancaFinal]
        );
        if (cachedImg.rows.length > 0) {
          const c = cachedImg.rows[0];
          await pool.query(`UPDATE avaliacoes SET created_at = NOW() WHERE id = $1`, [c.id]).catch(() => {});
          console.log(`[/avaliar] Cache imagem hit — avaliação ${c.id} reutilizada para usuário ${usuarioId}`);
          await log(usuarioId, null, 'avaliar_cache', 'ok', { tipo: 'imagem_hash', avaliacao_id: c.id, banca: bancaFinal });
          return res.json({
            avaliacao: typeof c.resultado === 'string' ? JSON.parse(c.resultado) : c.resultado,
            formato: 'json', banca: c.banca, cache: true, cache_tipo: 'identica'
          });
        }
      }
      // Guardar hash para usos futuros (injetado antes do INSERT final)
      req._imgHash = imgHash;
    }

    // ── CAMADA B: texto idêntico — SHA256 completo ─────────────────────
    if (!temImagem && redacao && redacao.trim().length >= 50) {
      // Verificar saldo antes do cache — se saldo=0, bypass (cobra e reavalia)
      const saldoCheck = await pool.query('SELECT avaliacoes_disponiveis FROM usuarios WHERE id = $1', [usuarioId]);
      const saldoAtual = saldoCheck.rows[0]?.avaliacoes_disponiveis || 0;

      if (saldoAtual > 0) {
        // SHA256 do texto normalizado completo — muito mais preciso que fingerprint 500 chars
        const textoNorm = redacao.trim().toLowerCase().replace(/\s+/g, ' ');
        const textoHash = require('crypto').createHash('sha256').update(textoNorm).digest('hex');
        const cached = await pool.query(
          `SELECT id, resultado, nota_geral, banca, created_at
           FROM avaliacoes
           WHERE usuario_id = $1
             AND MD5(LOWER(TRIM(REGEXP_REPLACE(COALESCE(redacao,''), '\\s+', ' ', 'g')))) = $2
             AND banca = $3
           ORDER BY created_at DESC LIMIT 1`,
          [usuarioId, require('crypto').createHash('md5').update(textoNorm).digest('hex'), bancaFinal]
        );
        if (cached.rows.length > 0) {
          const c = cached.rows[0];
          await pool.query(`UPDATE avaliacoes SET created_at = NOW() WHERE id = $1`, [c.id]).catch(() => {});
          console.log(`[/avaliar] Cache texto hit — avaliação ${c.id} reutilizada para usuário ${usuarioId}`);
          await log(usuarioId, null, 'avaliar_cache', 'ok', { tipo: 'texto_identico', avaliacao_id: c.id, banca: bancaFinal });
          return res.json({
            avaliacao: typeof c.resultado === 'string' ? JSON.parse(c.resultado) : c.resultado,
            formato: 'json', banca: c.banca, cache: true, cache_tipo: 'identica'
          });
        }
      }

      // ── CAMADA C (Jaccard similar) removida — responsabilidade do usuário
    }

    // ── WINSTON AI — detecção de possível texto gerado por IA ────────────
    // Apenas para texto digitado — não para foto/manuscrito
    // Não bloqueia, não altera nota — apenas flag pedagógica
    let possivel_ia = false;
    if (!temImagem && redacao && redacao.trim().length >= 50) {
      const wScore = await winstonDetect(redacao);
      if (wScore !== null && wScore >= 0.80) {
        possivel_ia = true;
        console.log(`[/avaliar] Winston IA detectada — score=${(wScore*100).toFixed(0)}% usuario=${usuario||'?'}`);
      }
    }

    const debitoResult = await pool.query(
      `UPDATE usuarios SET avaliacoes_disponiveis = avaliacoes_disponiveis - 1, total_redacoes = COALESCE(total_redacoes,0) + 1, updated_at = NOW() WHERE id = $1 AND avaliacoes_disponiveis > 0 RETURNING avaliacoes_disponiveis`,
      [usuarioId]
    );
    if (debitoResult.rowCount === 0) {
      const uCheck = await pool.query('SELECT avaliacoes_disponiveis FROM usuarios WHERE id = $1', [usuarioId]);
      if (!uCheck.rows.length) return res.status(401).json({ erro: 'Usuário não encontrado.' });
      await log(usuarioId, null, 'avaliar_erro', 'erro', { motivo: 'saldo_insuficiente', banca: bancaFinal });
      return res.status(402).json({ erro: 'Você não possui avaliações disponíveis.', saldo: 0 });
    }
    const saldoAposDebito = debitoResult.rows[0]?.avaliacoes_disponiveis ?? null;
    await log(usuarioId, null, 'avaliar_inicio', 'ok', { banca: bancaFinal, modo: temImagem ? 'foto' : 'texto', saldo_depois: saldoAposDebito });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 8000,
        system: 'Você é o RedaCheck. Responda SEMPRE e SOMENTE com JSON válido, sem nenhum texto adicional.',
        messages: [{ role: 'user', content: mensagemConteudo }]
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('[/avaliar] Erro API Anthropic:', JSON.stringify(data.error));
      return res.status(500).json({ erro: `Erro na API de avaliação: ${data.error.message || data.error.type || 'desconhecido'}` });
    }
    if (!data.content || !data.content[0]) {
      console.error('[/avaliar] Resposta vazia:', JSON.stringify(data));
      return res.status(500).json({ erro: 'API retornou resposta vazia.' });
    }

    const textoResposta = data.content[0].text;
    if (data.stop_reason === 'max_tokens') console.warn('[/avaliar] Resposta truncada por max_tokens!');

    let avaliacaoJSON;
    try {
      let limpo = textoResposta.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```\s*$/i,'').trim();
      const jsonStart = limpo.indexOf('{');
      const jsonEnd = limpo.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) limpo = limpo.substring(jsonStart, jsonEnd + 1);
      avaliacaoJSON = JSON.parse(limpo);
    } catch {
      try {
        const match = textoResposta.match(/\{[\s\S]*\}/);
        if (match) avaliacaoJSON = JSON.parse(match[0]);
        else throw new Error('JSON não encontrado');
      } catch {
        return res.json({ avaliacao: textoResposta, formato: 'texto', banca: bancaFinal });
      }
    }

    if (avaliacaoJSON.comentarioGeral)
      avaliacaoJSON.comentarioGeral = avaliacaoJSON.comentarioGeral.replace(/```json[\s\S]*?```/g,'').replace(/```[\s\S]*?```/g,'').trim();
    if (avaliacaoJSON.assinatura) delete avaliacaoJSON.assinatura;

    let usuarioIdFinal = usuarioId || null;
    if (!usuarioIdFinal) {
      try {
        const uResult = await pool.query('SELECT id FROM usuarios WHERE nome = $1 OR email = $1 LIMIT 1', [usuario || '']);
        if (uResult.rows.length) usuarioIdFinal = uResult.rows[0].id;
      } catch {}
    }

    try {
      // Garantir usuarioIdFinal preenchido — fallback por nome/email
      if (!usuarioIdFinal) {
        try {
          const uResult = await pool.query(
            'SELECT id FROM usuarios WHERE nome = $1 OR email = $1 LIMIT 1',
            [usuario || '']
          );
          if (uResult.rows.length) usuarioIdFinal = uResult.rows[0].id;
        } catch {}
      }

      // Se ainda null — estornar crédito e alertar
      if (!usuarioIdFinal) {
        await pool.query(
          `UPDATE usuarios SET avaliacoes_disponiveis = COALESCE(avaliacoes_disponiveis,0) + 1,
           total_redacoes = GREATEST(COALESCE(total_redacoes,0) - 1, 0), updated_at = NOW()
           WHERE id = $1`,
          [usuarioId]
        ).catch(e => console.error('[/avaliar] Erro ao estornar:', e.message));
        console.error('[/avaliar] usuarioIdFinal null — crédito estornado para usuarioId:', usuarioId);
        return res.json({
          avaliacao: avaliacaoJSON, formato: 'json', banca: bancaFinal,
          aviso: 'Avaliação realizada mas não salva no histórico. Crédito estornado automaticamente.'
        });
      }

      const imgHashFinal = req._imgHash || null;
      await pool.query(
        `INSERT INTO avaliacoes (usuario_id, usuario, banca, nota_geral, resultado, redacao, imagem_hash, possivel_ia)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [usuarioIdFinal, usuario || 'Anônimo', bancaFinal, avaliacaoJSON.notaGeral || 0,
         JSON.stringify(avaliacaoJSON),
         temImagem ? '[redação via foto]' : (redacao || '').substring(0, 2000),
         imgHashFinal, possivel_ia]
      );
      await log(usuarioIdFinal, null, 'avaliar_ok', 'ok', {
        banca: bancaFinal, nota_geral: avaliacaoJSON.notaGeral || 0,
        modo: temImagem ? 'foto' : 'texto'
      });
    } catch (dbErr) {
      // INSERT falhou — estornar crédito automaticamente
      console.error('[/avaliar] Erro ao salvar no banco:', dbErr.message);
      await pool.query(
        `UPDATE usuarios SET avaliacoes_disponiveis = COALESCE(avaliacoes_disponiveis,0) + 1,
         total_redacoes = GREATEST(COALESCE(total_redacoes,0) - 1, 0), updated_at = NOW()
         WHERE id = $1`,
        [usuarioIdFinal || usuarioId]
      ).catch(e => console.error('[/avaliar] Erro ao estornar:', e.message));
      await log(usuarioIdFinal || usuarioId, null, 'avaliar_estorno', 'ok', {
        motivo: dbErr.message, banca: bancaFinal
      });
      // Retorna a avaliação com aviso — usuário não perde o resultado
      return res.json({
        avaliacao: avaliacaoJSON, formato: 'json', banca: bancaFinal,
        aviso: 'Avaliação realizada mas não salva no histórico. Crédito estornado automaticamente.'
      });
    }

    res.json({ avaliacao: avaliacaoJSON, formato: 'json', banca: bancaFinal, possivel_ia });

  } catch (err) {
    console.error('[/avaliar] Erro interno:', err);
    res.status(500).json({ erro: 'Erro interno ao processar avaliação. Tente novamente.' });
  }
});

// ── AVALIAR COM PAGAMENTO AVULSO — atomic ────────────────────────────
// Verifica pagamento no MP, credita e debita atomicamente, retorna avaliação
// Elimina a corrida entre webhook e /avaliar
app.post('/avaliar-pago', async (req, res) => {
  try {
    const { payment_id, usuarioId, redacao, banca, usuario, imagem, mediaType } = req.body;
    if (!payment_id || !usuarioId) return res.status(400).json({ erro: 'Dados incompletos.' });

    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

    // 1. Verificar pagamento no MP
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
    });
    const pag = await mpResp.json();

    if (pag.status !== 'approved')
      return res.status(402).json({ erro: 'Pagamento não aprovado.', status: pag.status });

    // 2. Idempotência — verificar se já foi processado
    const jaProcessado = await pool.query(
      `SELECT id FROM pagamentos WHERE payment_id = $1 AND status = 'aprovado'`,
      [String(payment_id)]
    );

    // 3. Se não processado, creditar atomicamente
    if (jaProcessado.rows.length === 0) {
      const [usuarioIdRef, pacote, qtd] = (pag.external_reference || '').split('|');
      const avalQtd = parseInt(qtd) || 1;
      await pool.query(
        `UPDATE usuarios SET avaliacoes_disponiveis = COALESCE(avaliacoes_disponiveis,0) + $1, updated_at = NOW() WHERE id = $2`,
        [avalQtd, usuarioId]
      );
      await pool.query(
        `UPDATE pagamentos SET status = 'aprovado', updated_at = NOW()
         WHERE usuario_id = $1 AND payment_id = $2`,
        [usuarioId, String(payment_id)]
      ).catch(() => {});
      await log(usuarioId, null, 'credito', 'ok', { origem: 'avaliar_pago', payment_id: String(payment_id), qtd: avalQtd });
    }

    // 4. Debitar 1 avaliação atomicamente
    const debitoResult = await pool.query(
      `UPDATE usuarios SET avaliacoes_disponiveis = avaliacoes_disponiveis - 1,
       total_redacoes = COALESCE(total_redacoes,0) + 1, updated_at = NOW()
       WHERE id = $1 AND avaliacoes_disponiveis > 0
       RETURNING avaliacoes_disponiveis`,
      [usuarioId]
    );

    if (debitoResult.rowCount === 0)
      return res.status(402).json({ erro: 'Saldo insuficiente após pagamento. Tente novamente.' });

    await log(usuarioId, null, 'avaliar_inicio', 'ok', { origem: 'avaliar_pago', payment_id: String(payment_id) });

    // 5. Processar avaliação (mesmo código do /avaliar)
    const bancaNorm = (banca || 'ENEM').toUpperCase().replace(/ /g, '_');
    const promptSistema = PROMPTS[bancaNorm] || PROMPTS['ENEM'];
    const bancaFinal = PROMPTS[bancaNorm] ? bancaNorm : 'ENEM';
    const temImagem = imagem && imagem.length > 100;
    const MIME_VALIDOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const mimeRaw = mediaType || 'image/jpeg';
    const mimeFinal = MIME_VALIDOS.includes(mimeRaw) ? mimeRaw : 'image/jpeg';

    let mensagemConteudo;
    if (temImagem) {
      mensagemConteudo = [
        { type: 'image', source: { type: 'base64', media_type: mimeFinal, data: imagem } },
        { type: 'text', text: `${promptSistema}
${SCHEMA_JSON}

Analise a imagem acima. Ela contém uma redação manuscrita. Avalie para a banca ${bancaFinal}.` }
      ];
    } else {
      mensagemConteudo = `${promptSistema}
${SCHEMA_JSON}

Avalie para a banca ${bancaFinal}:

REDAÇÃO:
${redacao}`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 8000,
        system: 'Você é o RedaCheck. Responda SEMPRE e SOMENTE com JSON válido, sem nenhum texto adicional.',
        messages: [{ role: 'user', content: mensagemConteudo }] })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ erro: 'Erro na API de avaliação.' });

    const textoResposta = data.content[0].text;
    let avaliacaoJSON;
    try {
      let limpo = textoResposta.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```\s*$/i,'').trim();
      const jsonStart = limpo.indexOf('{'); const jsonEnd = limpo.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) limpo = limpo.substring(jsonStart, jsonEnd + 1);
      avaliacaoJSON = JSON.parse(limpo);
    } catch { return res.status(500).json({ erro: 'Erro ao processar avaliação.' }); }

    if (avaliacaoJSON.comentarioGeral)
      avaliacaoJSON.comentarioGeral = avaliacaoJSON.comentarioGeral.replace(/```[\s\S]*?```/g,'').trim();
    if (avaliacaoJSON.assinatura) delete avaliacaoJSON.assinatura;

    // 6. Salvar avaliação
    const imgHash = temImagem ? require('crypto').createHash('sha256').update(imagem).digest('hex') : null;
    await pool.query(
      `INSERT INTO avaliacoes (usuario_id, usuario, banca, nota_geral, resultado, redacao, imagem_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [usuarioId, usuario || 'Anônimo', bancaFinal, avaliacaoJSON.notaGeral || 0,
       JSON.stringify(avaliacaoJSON), temImagem ? '[redação via foto]' : (redacao||'').substring(0,2000), imgHash]
    );
    await log(usuarioId, null, 'avaliar_ok', 'ok', { banca: bancaFinal, nota_geral: avaliacaoJSON.notaGeral || 0, origem: 'avaliar_pago' });

    const saldoFinal = await pool.query('SELECT avaliacoes_disponiveis FROM usuarios WHERE id = $1', [usuarioId]);
    res.json({ avaliacao: avaliacaoJSON, formato: 'json', banca: bancaFinal, avaliacoes_disponiveis: saldoFinal.rows[0]?.avaliacoes_disponiveis || 0 });

  } catch (err) {
    console.error('[/avaliar-pago]', err.message);
    res.status(500).json({ erro: 'Erro ao processar.' });
  }
});

// ── FEEDBACKS APROVADOS — exibidos na home ───────────────────────────
app.get('/feedbacks-aprovados', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT usuario, nota, comentario, created_at
       FROM feedbacks
       WHERE aprovado = TRUE AND comentario != ''
       ORDER BY created_at DESC LIMIT 100`
    );
    res.json({ feedbacks: result.rows });
  } catch(err) {
    res.status(500).json({ erro: 'Erro ao buscar feedbacks.' });
  }
});

app.get('/historico/:usuario', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, banca, nota_geral, created_at, LEFT(redacao, 150) as redacao_preview
       FROM avaliacoes WHERE usuario=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.usuario]
    );
    res.json({ avaliacoes: result.rows });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar histórico.' });
  }
});

// ── HISTÓRICO POR ID (seguro — não cruza dados por nome) ─────────────
app.get('/historico-id/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT id, banca, nota_geral, created_at, LEFT(redacao, 150) as redacao_preview
       FROM avaliacoes
       WHERE usuario_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [id]
    );
    res.json({ avaliacoes: result.rows });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar histórico.' });
  }
});

app.get('/avaliacao/:id', async (req, res) => {
  try {
    const { usuario_id } = req.query;
    if (!usuario_id) return res.status(401).json({ erro: 'Identificação obrigatória.' });
    const result = await pool.query('SELECT * FROM avaliacoes WHERE id=$1 AND usuario_id=$2', [req.params.id, usuario_id]);
    if (!result.rows.length) return res.status(404).json({ erro: 'Avaliação não encontrada.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar avaliação.' });
  }
});

// ── RECUPERAR AVALIAÇÃO SIMILAR (usuário confirmou "é a mesma") ───────
// Retorna resultado da avaliação anterior sem debitar saldo
app.get('/avaliacao-similar/:id', async (req, res) => {
  try {
    const { usuario_id } = req.query;
    if (!usuario_id) return res.status(401).json({ erro: 'Identificação obrigatória.' });
    const result = await pool.query(
      'SELECT id, resultado, nota_geral, banca, created_at FROM avaliacoes WHERE id=$1 AND usuario_id=$2',
      [req.params.id, usuario_id]
    );
    if (!result.rows.length) return res.status(404).json({ erro: 'Avaliação não encontrada.' });
    const c = result.rows[0];
    // Atualizar created_at para aparecer no topo do histórico
    await pool.query(`UPDATE avaliacoes SET created_at = NOW() WHERE id = $1`, [c.id]).catch(() => {});
    await log(usuario_id, null, 'avaliar_cache', 'ok', { tipo: 'similar_confirmado', avaliacao_id: c.id, banca: c.banca });
    res.json({
      avaliacao: typeof c.resultado === 'string' ? JSON.parse(c.resultado) : c.resultado,
      formato: 'json', banca: c.banca, cache: true, cache_tipo: 'similar_confirmado'
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao recuperar avaliação similar.' });
  }
});

app.post('/log/conversa', async (req, res) => {
  try {
    const { usuario, mensagens, dataInicio, duracao } = req.body;
    const result = await pool.query(
      `INSERT INTO conversas (usuario, mensagens, data_inicio, duracao) VALUES ($1,$2,$3,$4) RETURNING id`,
      [usuario || 'Anônimo', JSON.stringify(mensagens || []), dataInicio || new Date().toISOString(), duracao || 0]
    );
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar conversa.' });
  }
});

app.post('/log/feedback', async (req, res) => {
  try {
    const { usuario, nota, comentario } = req.body;
    const result = await pool.query(
      `INSERT INTO feedbacks (usuario, nota, comentario) VALUES ($1,$2,$3) RETURNING id`,
      [usuario || 'Anônimo', nota || 0, comentario || '']
    );
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar feedback.' });
  }
});

app.post('/log/sugestao', async (req, res) => {
  try {
    const { usuario, texto } = req.body;
    const result = await pool.query(
      `INSERT INTO sugestoes (usuario, texto) VALUES ($1,$2) RETURNING id`,
      [usuario || 'Anônimo', texto || '']
    );
    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao salvar sugestão.' });
  }
});

app.patch('/log/:tipo/:id', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Não autorizado.' });
  try {
    const { tipo, id } = req.params;
    const { status, notaOperador, tags } = req.body;
    const tabelas = { conversas: 'conversas', feedbacks: 'feedbacks', sugestoes: 'sugestoes' };
    if (!tabelas[tipo]) return res.status(404).json({ erro: 'Tipo inválido.' });
    const updates = []; const values = []; let idx = 1;
    if (status) { updates.push(`status=$${idx++}`); values.push(status); }
    if (notaOperador !== undefined) { updates.push(`nota_operador=$${idx++}`); values.push(notaOperador); }
    if (tags) { updates.push(`tags=$${idx++}`); values.push(JSON.stringify(tags)); }
    if (!updates.length) return res.status(400).json({ erro: 'Nada para atualizar.' });
    values.push(id);
    await pool.query(`UPDATE ${tabelas[tipo]} SET ${updates.join(', ')} WHERE id=$${idx}`, values);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar.' });
  }
});

// ── MASTER ────────────────────────────────────────────────────────────
const MASTER_TOKEN = process.env.MASTER_TOKEN;
if (!MASTER_TOKEN) console.error('⚠️  MASTER_TOKEN não configurado!');

app.delete('/master/limpar-usuarios', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    await pool.query('DELETE FROM solicitacoes_professor');
    await pool.query('DELETE FROM avaliacoes');
    await pool.query('DELETE FROM usuarios');
    res.json({ ok: true, mensagem: 'Tabelas limpas.' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

const _masterCodigos = new Map();

app.post('/master/solicitar-codigo', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Token inválido.' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ erro: 'E-mail obrigatório.' });
  const codigo = Math.floor(100000 + Math.random() * 900000).toString();
  const expira = Date.now() + 10 * 60 * 1000;
  _masterCodigos.set(email, { codigo, expira });
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'noreply@redacheck.com.br',
      to: email,
      subject: 'RedaCheck Master — Código de acesso',
      html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px"><h2 style="color:#1A1A1A">Código de acesso Master</h2><p style="color:#6B6255;margin:12px 0">Seu código de verificação:</p><div style="font-size:36px;font-weight:700;color:#C96A3A;letter-spacing:8px;padding:16px;background:#F5F2EE;border-radius:12px;text-align:center">${codigo}</div><p style="color:#9B9080;font-size:12px;margin-top:12px">Válido por 10 minutos. Não compartilhe.</p></div>`
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ erro: 'Erro ao enviar código.' });
  }
});

app.post('/master/verificar-codigo', (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Token inválido.' });
  const { email, codigo } = req.body;
  const entry = _masterCodigos.get(email);
  if (!entry) return res.status(400).json({ erro: 'Nenhum código solicitado.' });
  if (Date.now() > entry.expira) { _masterCodigos.delete(email); return res.status(400).json({ erro: 'Código expirado.' }); }
  if (entry.codigo !== String(codigo)) return res.status(400).json({ erro: 'Código incorreto.' });
  _masterCodigos.delete(email);
  res.json({ ok: true, sessaoExpira: Date.now() + 4 * 60 * 60 * 1000 });
});

app.patch('/master/usuario/:id', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Não autorizado.' });
  try {
    const { id } = req.params;
    const { nome, email, avaliacoes_disponiveis, plano } = req.body;
    const updates = [], vals = [];
    let idx = 1;
    if (nome !== undefined)                  { updates.push(`nome = $${idx++}`);                   vals.push(nome); }
    if (email !== undefined)                 { updates.push(`email = $${idx++}`);                  vals.push(email); }
    if (avaliacoes_disponiveis !== undefined) { updates.push(`avaliacoes_disponiveis = $${idx++}`); vals.push(parseInt(avaliacoes_disponiveis)); }
    if (plano !== undefined)                 { updates.push(`plano = $${idx++}`);                  vals.push(plano); }
    if (!updates.length) return res.status(400).json({ erro: 'Nenhum campo para atualizar.' });
    updates.push('updated_at = NOW()');
    vals.push(id);
    await pool.query(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = $${idx}`, vals);
    if (avaliacoes_disponiveis !== undefined) {
      await log(id, null, 'credito', 'ok', { origem: 'master_edicao', saldo_definido: parseInt(avaliacoes_disponiveis) });
    }
    await log(id, null, 'master_editar_usuario', 'ok', { campos: Object.keys(req.body) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: 'Erro ao editar usuário.' }); }
});

app.delete('/master/usuario/:id', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Não autorizado.' });
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM avaliacoes WHERE usuario_id = $1', [id]);
    await pool.query('DELETE FROM pagamentos WHERE usuario_id = $1', [id]);
    await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: 'Erro ao remover usuário.' }); }
});

app.get('/master/dados', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    const [conversas, feedbacks, sugestoes, resumo, professores, ultimasAvaliacoes] = await Promise.all([
      pool.query('SELECT * FROM conversas ORDER BY created_at DESC LIMIT 100'),
      pool.query('SELECT * FROM feedbacks ORDER BY created_at DESC LIMIT 100'),
      pool.query('SELECT * FROM sugestoes ORDER BY created_at DESC LIMIT 100'),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM conversas) as total_conversas,
          (SELECT COUNT(*) FROM feedbacks) as total_feedbacks,
          (SELECT COALESCE(ROUND(AVG(nota),1),0) FROM feedbacks) as media_estrelas,
          (SELECT COUNT(*) FROM usuarios) as total_usuarios,
          (SELECT COUNT(*) FROM usuarios WHERE confirmado=TRUE) as usuarios_confirmados,
          (SELECT COUNT(*) FROM avaliacoes) as total_avaliacoes,
          (SELECT COALESCE(ROUND(AVG(nota_geral),0),0) FROM avaliacoes) as media_nota_redacao
      `),
      pool.query("SELECT * FROM sugestoes WHERE texto LIKE '[CADASTRO PROFESSOR]%' ORDER BY created_at DESC LIMIT 50"),
      pool.query('SELECT usuario, banca, nota_geral, created_at FROM avaliacoes ORDER BY created_at DESC LIMIT 20')
    ]);
    res.json({
      resumo: resumo.rows[0], conversas: conversas.rows,
      feedbacks: feedbacks.rows, sugestoes: sugestoes.rows,
      professores: professores.rows, ultimasAvaliacoes: ultimasAvaliacoes.rows
    });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao carregar dados.' });
  }
});

// ── MERCADO PAGO ──────────────────────────────────────────────────────
const PACOTES = {
  avulso:        { qtd: 1,  valor: 4.90,  descricao: '1 avaliação' },
  basico:        { qtd: 5,  valor: 19.90, descricao: '5 avaliações' },
  intermediario: { qtd: 10, valor: 34.90, descricao: '10 avaliações' },
  avancado:      { qtd: 20, valor: 68.60, descricao: '20 avaliações' }
};
const PACOTES_PROFESSOR = {
  avulso:        { qtd: 1,  valor: 2.45,  descricao: '1 avaliação (professor)' },
  basico:        { qtd: 5,  valor: 9.95,  descricao: '5 avaliações (professor)' },
  intermediario: { qtd: 10, valor: 17.45, descricao: '10 avaliações (professor)' },
  avancado:      { qtd: 20, valor: 34.30, descricao: '20 avaliações (professor)' }
};

app.post('/pagamento/criar', async (req, res) => {
  try {
    const { pacote, usuarioId, email, professor } = req.body;
    if (!pacote || !usuarioId || !email) return res.status(400).json({ erro: 'Dados incompletos.' });
    const tabela = professor ? PACOTES_PROFESSOR : PACOTES;
    const item = tabela[pacote];
    if (!item) return res.status(400).json({ erro: 'Pacote inválido.' });
    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!MP_ACCESS_TOKEN) return res.status(500).json({ erro: 'Pagamento não configurado.' });

    const preferencia = {
      items: [{
        id: pacote,
        title: `RedaCheck — ${item.descricao}`,
        description: `${item.qtd} avaliação(ões) de redação`,
        quantity: 1, currency_id: 'BRL', unit_price: item.valor
      }],
      payer: { email },
      payment_methods: { excluded_payment_types: [], installments: 1 },
      back_urls: {
        success: 'https://redacheck.com.br/?pagamento=sucesso',
        failure: 'https://redacheck.com.br/?pagamento=falhou',
        pending: 'https://redacheck.com.br/?pagamento=pendente'
      },
      auto_return: 'approved',
      external_reference: `${usuarioId}|${pacote}|${item.qtd}`,
      notification_url: 'https://redacheck-backend-production-25c3.up.railway.app/pagamento/webhook',
      statement_descriptor: 'REDACHECK'
    };

    const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
      body: JSON.stringify(preferencia)
    });
    const data = await resp.json();
    if (data.error) return res.status(500).json({ erro: data.message || 'Erro ao criar pagamento.' });

    await pool.query(
      `INSERT INTO pagamentos (usuario_id, pacote, avaliacoes, valor, status, preferencia_id, created_at)
       VALUES ($1,$2,$3,$4,'pendente',$5,NOW()) ON CONFLICT DO NOTHING`,
      [usuarioId, pacote, item.qtd, item.valor, data.id]
    ).catch(() => {});

    res.json({ ok: true, preferencia_id: data.id, init_point: data.init_point, sandbox_init_point: data.sandbox_init_point });
  } catch (err) {
    console.error('[/pagamento/criar]', err.message);
    res.status(500).json({ erro: 'Erro ao processar pagamento.' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// WEBHOOK MERCADO PAGO — v9.2
// FIX: UPDATE pagamentos por payment_id OU preferencia_id
//      (Pix nativo não usa preferencia_id — bug original)
// ══════════════════════════════════════════════════════════════════════
app.post('/pagamento/webhook', async (req, res) => {
  try {
    const MP_SECRET = process.env.MP_WEBHOOK_SECRET;
    if (MP_SECRET) {
      const xSig = req.headers['x-signature'] || '';
      const xReqId = req.headers['x-request-id'] || '';
      const dataId = req.query['data.id'] || req.body?.data?.id || '';
      const ts = (xSig.match(/ts=([^,]+)/) || [])[1] || '';
      const sigRec = (xSig.match(/v1=([a-f0-9]+)/) || [])[1] || '';
      if (sigRec) {
        const crypto = require('crypto');
        const manifest = `id:${dataId};request-id:${xReqId};ts:${ts}`;
        const sigEsp = crypto.createHmac('sha256', MP_SECRET).update(manifest).digest('hex');
        if (sigRec !== sigEsp) { console.warn('[webhook] Assinatura inválida'); return res.sendStatus(200); }
      }
    }

    const { type, data } = req.body;
    if (type !== 'payment') return res.sendStatus(200);

    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
    const pagResp = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
    });
    const pagamento = await pagResp.json();

    if (pagamento.status !== 'approved') return res.sendStatus(200);

    const [usuarioId, pacote, avaliacoes] = (pagamento.external_reference || '').split('|');
    if (!usuarioId) return res.sendStatus(200);
    const qtd = parseInt(avaliacoes) || 0;

    // ── Idempotência: verificar se payment_id já foi processado ──────
    const jaProcessado = await pool.query(
      `SELECT id FROM pagamentos WHERE payment_id = $1 AND status = 'aprovado'`,
      [String(data.id)]
    );
    if (jaProcessado.rows.length > 0) {
      console.log('[webhook] Já processado, ignorando:', data.id);
      return res.sendStatus(200);
    }

    // ── v9.2 FIX: log antes do crédito para rastreabilidade ──────────
    console.log(`[webhook] Creditando ${qtd} avaliações → usuario_id=${usuarioId} payment_id=${data.id} pacote=${pacote}`);

    // ── Credita avaliacoes_disponiveis ────────────────────────────────
    await pool.query(
      `UPDATE usuarios SET avaliacoes_disponiveis = COALESCE(avaliacoes_disponiveis,0) + $1, updated_at = NOW() WHERE id = $2`,
      [qtd, usuarioId]
    );

    console.log(`[webhook] Crédito OK → usuario_id=${usuarioId} +${qtd} avaliações`);
    await log(usuarioId, null, 'credito', 'ok', { origem: 'webhook_pix', payment_id: String(data.id), pacote, qtd });

    // ── v9.2 FIX: UPDATE por payment_id OU preferencia_id ────────────
    // Pix nativo não tem preferencia_id — a versão anterior falhava silenciosamente
    await pool.query(
      `UPDATE pagamentos
       SET status = 'aprovado', payment_id = $1, updated_at = NOW()
       WHERE usuario_id = $3
         AND status = 'pendente'
         AND (preferencia_id = $2 OR payment_id = $1)`,
      [String(data.id), pagamento.preference_id || '', usuarioId]
    ).catch(e => console.error('[webhook] Erro ao atualizar pagamento:', e.message));

    console.log(`[webhook] Aprovado: usuário ${usuarioId}, +${qtd} avaliações, payment_id=${data.id}`);

    // ── E-mail de confirmação ─────────────────────────────────────────
    try {
      const uRes = await pool.query(
        `SELECT nome, email, COALESCE(avaliacoes_disponiveis, 0) AS saldo_atual
         FROM usuarios WHERE id = $1`,
        [usuarioId]
      );
      if (uRes.rows.length > 0) {
        const u = uRes.rows[0];
        const primeiroNome = u.nome.split(' ')[0];
        const nomePacote = {
          avulso: '1 avaliação',
          basico: 'Pacote Básico — 5 avaliações',
          intermediario: 'Pacote Intermediário — 10 avaliações',
          avancado: 'Pacote Avançado — 20 avaliações'
        }[pacote] || `${qtd} avaliação(ões)`;
        const valor = pagamento.transaction_amount
          ? `R$ ${Number(pagamento.transaction_amount).toFixed(2).replace('.', ',')}`
          : '';
        const ano = new Date().getFullYear();
        await enviarEmail(u.email, 'RedaCheck — Pagamento confirmado! ✅', `
          <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#FAF9F7">
            <div style="text-align:center;margin-bottom:24px">
              <span style="font-size:22px;font-weight:700;letter-spacing:3px;color:#1A1A1A">REDA<span style="color:#C96A3A">CHECK</span></span>
              <div style="font-size:10px;color:#9B9080;letter-spacing:1.5px;margin-top:4px">MAIS QUE CORRIGIR — APERFEIÇOAR</div>
            </div>
            <h2 style="font-size:20px;color:#1A1A1A;margin-bottom:8px">Pagamento confirmado, ${primeiroNome}! 🎉</h2>
            <p style="font-size:14px;color:#6B6255;line-height:1.7;margin-bottom:20px">
              Seu pagamento foi aprovado e suas avaliações já estão disponíveis na plataforma.
            </p>
            <div style="background:#1A1A1A;border-radius:16px;padding:24px;margin-bottom:20px">
              <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">Resumo do pedido</div>
              <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                <span style="font-size:13px;color:rgba(255,255,255,0.7)">Pacote</span>
                <span style="font-size:13px;color:#FAF9F7;font-weight:600">${nomePacote}</span>
              </div>
              ${valor ? `<div style="display:flex;justify-content:space-between;margin-bottom:8px">
                <span style="font-size:13px;color:rgba(255,255,255,0.7)">Valor pago</span>
                <span style="font-size:13px;color:#FAF9F7;font-weight:600">${valor}</span>
              </div>` : ''}
              <div style="border-top:1px solid rgba(255,255,255,0.1);margin-top:12px;padding-top:12px;display:flex;justify-content:space-between">
                <span style="font-size:13px;color:rgba(255,255,255,0.7)">Saldo atual</span>
                <span style="font-size:16px;color:#C96A3A;font-weight:700">${u.saldo_atual} avaliação(ões)</span>
              </div>
            </div>
            <a href="https://redacheck.com.br" style="display:block;background:#C96A3A;color:white;text-decoration:none;text-align:center;padding:14px;border-radius:12px;font-size:15px;font-weight:600;margin-bottom:20px">
              Acessar o RedaCheck →
            </a>
            <p style="font-size:12px;color:#9B9080;line-height:1.6;text-align:center">
              Dúvidas? Entre em contato: contato@redacheck.com.br
            </p>
            <div style="border-top:1px solid #E5E0D8;margin-top:24px;padding-top:16px;text-align:center">
              <span style="font-size:11px;color:#9B9080">© ${ano} RedaCheck — redacheck.com.br</span>
            </div>
          </div>
        `);
        console.log(`[webhook] E-mail de confirmação enviado para: ${u.email}`);
      }
    } catch (emailErr) {
      console.error('[webhook] Falha ao enviar e-mail de confirmação:', emailErr.message);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook]', err.message);
    res.sendStatus(200);
  }
});

app.post('/pagamento/criar-brick', async (req, res) => {
  try {
    const { pacote, usuarioId, email } = req.body;
    if (!pacote || !usuarioId || !email) return res.status(400).json({ erro: 'Dados incompletos.' });
    // Segurança: verificar desconto no banco, não confiar no frontend
    const uCheck = await pool.query('SELECT desconto_professor FROM usuarios WHERE id = $1', [usuarioId]);
    const professor = uCheck.rows[0]?.desconto_professor === true;
    const tabela = professor ? PACOTES_PROFESSOR : PACOTES;
    const item = tabela[pacote];
    if (!item) return res.status(400).json({ erro: 'Pacote inválido.' });
    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!MP_ACCESS_TOKEN) return res.status(500).json({ erro: 'Pagamento não configurado.' });

    const preferencia = {
      items: [{
        id: pacote,
        title: `RedaCheck — ${item.descricao}`,
        description: `${item.qtd} avaliação(ões) de redação`,
        quantity: 1, currency_id: 'BRL', unit_price: item.valor
      }],
      payer: { email },
      payment_methods: {
        excluded_payment_types: [
          { id: 'ticket' },
          { id: 'atm' },
          { id: 'prepaid_card' }
        ],
        excluded_payment_methods: [],
        installments: 1
      },
      back_urls: {
        success: 'https://redacheck.com.br/?pagamento=sucesso',
        failure: 'https://redacheck.com.br/?pagamento=falhou',
        pending: 'https://redacheck.com.br/?pagamento=pendente'
      },
      auto_return: 'approved',
      external_reference: `${usuarioId}|${pacote}|${item.qtd}`,
      notification_url: 'https://redacheck-backend-production-25c3.up.railway.app/pagamento/webhook',
      statement_descriptor: 'REDACHECK'
    };

    const resp = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
      body: JSON.stringify(preferencia)
    });
    const data = await resp.json();
    if (data.error) return res.status(500).json({ erro: data.message || 'Erro ao criar pagamento.' });

    await pool.query(
      `INSERT INTO pagamentos (usuario_id, pacote, avaliacoes, valor, status, preferencia_id, created_at)
       VALUES ($1,$2,$3,$4,'pendente',$5,NOW()) ON CONFLICT DO NOTHING`,
      [usuarioId, pacote, item.qtd, item.valor, data.id]
    ).catch(() => {});

    res.json({
      ok: true,
      preference_id: data.id,
      public_key: process.env.MP_PUBLIC_KEY || ''
    });
  } catch (err) {
    console.error('[/pagamento/criar-brick]', err.message);
    res.status(500).json({ erro: 'Erro ao processar pagamento.' });
  }
});

app.post('/pagamento/processar', async (req, res) => {
  try {
    const { token, payment_method_id, payer, transaction_amount,
            installments, issuer_id, usuarioId, pacote, professor,
            payment_type } = req.body;

    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!MP_ACCESS_TOKEN) return res.status(500).json({ erro: 'Pagamento não configurado.' });

    // Segurança: verificar desconto no banco, não confiar no frontend
    const uCheckProc = await pool.query('SELECT desconto_professor FROM usuarios WHERE id = $1', [usuarioId]);
    const professorVerificado = uCheckProc.rows[0]?.desconto_professor === true;
    const tabela = professorVerificado ? PACOTES_PROFESSOR : PACOTES;
    const item = tabela[pacote];
    if (!item) return res.status(400).json({ erro: 'Pacote inválido.' });

    const pagBody = {
      transaction_amount: item.valor,
      token,
      payment_method_id,
      installments: installments || 1,
      issuer_id,
      payer,
      external_reference: `${usuarioId}|${pacote}|${item.qtd}`,
      notification_url: 'https://redacheck-backend-production-25c3.up.railway.app/pagamento/webhook',
      statement_descriptor: 'REDACHECK',
      additional_info: {
        items: [{
          id: pacote,
          title: `RedaCheck — ${item.descricao}`,
          quantity: 1,
          unit_price: item.valor
        }]
      }
    };

    const mpResp = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'X-Idempotency-Key': `rc-${usuarioId}-${pacote}-${Date.now()}`
      },
      body: JSON.stringify(pagBody)
    });
    const pagamento = await mpResp.json();

    console.log(`[/processar] status=${pagamento.status} id=${pagamento.id} usuario=${usuarioId}`);
    await log(usuarioId, payer?.email || null, 'cartao_processado', pagamento.status === 'approved' ? 'ok' : 'pendente', { payment_id: pagamento.id, status: pagamento.status, pacote, valor: item.valor });

    if (pagamento.status === 'approved') {
      await pool.query(
        `UPDATE usuarios SET avaliacoes_disponiveis = COALESCE(avaliacoes_disponiveis,0) + $1, updated_at = NOW() WHERE id = $2`,
        [item.qtd, usuarioId]
      );

      await pool.query(
        `INSERT INTO pagamentos (usuario_id, pacote, avaliacoes, valor, status, payment_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'aprovado',$5,NOW(),NOW()) ON CONFLICT DO NOTHING`,
        [usuarioId, pacote, item.qtd, item.valor, String(pagamento.id)]
      ).catch(() => {});

      const saldoRes = await pool.query(
        'SELECT avaliacoes_disponiveis, nome, email FROM usuarios WHERE id = $1',
        [usuarioId]
      );
      const u = saldoRes.rows[0];
      await log(usuarioId, u?.email || null, 'credito', 'ok', { origem: 'cartao', payment_id: String(pagamento.id), pacote, qtd: item.qtd, saldo_depois: u?.avaliacoes_disponiveis || 0 });

      if (u) {
        try {
          const primeiroNome = u.nome.split(' ')[0];
          const nomePacote = { avulso:'1 avaliação', basico:'Pacote Básico — 5 avaliações',
            intermediario:'Pacote Intermediário — 10 avaliações', avancado:'Pacote Avançado — 20 avaliações'
          }[pacote] || `${item.qtd} avaliação(ões)`;
          const ano = new Date().getFullYear();
          await enviarEmail(u.email, 'RedaCheck — Pagamento confirmado! ✅', `
            <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#FAF9F7">
              <div style="text-align:center;margin-bottom:24px">
                <span style="font-size:22px;font-weight:700;letter-spacing:3px;color:#1A1A1A">REDA<span style="color:#C96A3A">CHECK</span></span>
                <div style="font-size:10px;color:#9B9080;letter-spacing:1.5px;margin-top:4px">MAIS QUE CORRIGIR — APERFEIÇOAR</div>
              </div>
              <h2 style="font-size:20px;color:#1A1A1A;margin-bottom:8px">Pagamento confirmado, ${primeiroNome}! 🎉</h2>
              <p style="font-size:14px;color:#6B6255;line-height:1.7;margin-bottom:20px">Seu pagamento foi aprovado e suas avaliações já estão disponíveis.</p>
              <div style="background:#1A1A1A;border-radius:16px;padding:24px;margin-bottom:20px">
                <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:12px">Resumo do pedido</div>
                <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                  <span style="font-size:13px;color:rgba(255,255,255,0.7)">Pacote</span>
                  <span style="font-size:13px;color:#FAF9F7;font-weight:600">${nomePacote}</span>
                </div>
                <div style="display:flex;justify-content:space-between;margin-bottom:8px">
                  <span style="font-size:13px;color:rgba(255,255,255,0.7)">Valor pago</span>
                  <span style="font-size:13px;color:#FAF9F7;font-weight:600">R$ ${item.valor.toFixed(2).replace('.',',')}</span>
                </div>
                <div style="border-top:1px solid rgba(255,255,255,0.1);margin-top:12px;padding-top:12px;display:flex;justify-content:space-between">
                  <span style="font-size:13px;color:rgba(255,255,255,0.7)">Saldo atual</span>
                  <span style="font-size:16px;color:#C96A3A;font-weight:700">${u.avaliacoes_disponiveis} avaliação(ões)</span>
                </div>
              </div>
              <a href="https://redacheck.com.br" style="display:block;background:#C96A3A;color:white;text-decoration:none;text-align:center;padding:14px;border-radius:12px;font-size:15px;font-weight:600;margin-bottom:20px">Acessar o RedaCheck →</a>
              <div style="border-top:1px solid #E5E0D8;margin-top:24px;padding-top:16px;text-align:center">
                <span style="font-size:11px;color:#9B9080">© ${ano} RedaCheck — redacheck.com.br</span>
              </div>
            </div>
          `);
        } catch(emailErr) {
          console.error('[processar] e-mail:', emailErr.message);
        }
      }

      return res.json({
        status: 'approved',
        avaliacoes_disponiveis: u?.avaliacoes_disponiveis || 0
      });
    }

    res.json({ status: pagamento.status, status_detail: pagamento.status_detail });

  } catch (err) {
    console.error('[/pagamento/processar]', err.message);
    res.status(500).json({ erro: 'Erro ao processar pagamento.' });
  }
});

// ── PAGAMENTO PIX NATIVO — v9.2 com log de rastreabilidade ───────────
app.post('/pagamento/pix', async (req, res) => {
  try {
    const { pacote, usuarioId, email } = req.body;
    if (!pacote || !usuarioId || !email) return res.status(400).json({ erro: 'Dados incompletos.' });
    // Segurança: verificar desconto no banco, não confiar no frontend
    const uCheck = await pool.query('SELECT desconto_professor FROM usuarios WHERE id = $1', [usuarioId]);
    const professor = uCheck.rows[0]?.desconto_professor === true;
    const tabela = professor ? PACOTES_PROFESSOR : PACOTES;
    const item = tabela[pacote];
    if (!item) return res.status(400).json({ erro: 'Pacote inválido.' });
    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
    if (!MP_ACCESS_TOKEN) return res.status(500).json({ erro: 'Pagamento não configurado.' });

    const pagBody = {
      transaction_amount: item.valor,
      description: `RedaCheck — ${item.descricao}`,
      payment_method_id: 'pix',
      payer: { email, first_name: 'Usuário', last_name: 'RedaCheck' },
      external_reference: `${usuarioId}|${pacote}|${item.qtd}`,
      notification_url: 'https://redacheck-backend-production-25c3.up.railway.app/pagamento/webhook'
    };

    const mpResp = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
        'X-Idempotency-Key': `pix-${usuarioId}-${pacote}-${Date.now()}`
      },
      body: JSON.stringify(pagBody)
    });
    const pag = await mpResp.json();

    if (pag.error || !pag.point_of_interaction?.transaction_data) {
      console.error('[/pix] Erro MP:', JSON.stringify(pag));
      return res.status(500).json({ erro: pag.message || 'Erro ao gerar Pix.' });
    }

    const pixData = pag.point_of_interaction.transaction_data;

    // Registrar pagamento pendente com payment_id (Pix não usa preferencia_id)
    await pool.query(
      `INSERT INTO pagamentos (usuario_id, pacote, avaliacoes, valor, status, payment_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'pendente',$5,NOW(),NOW()) ON CONFLICT DO NOTHING`,
      [usuarioId, pacote, item.qtd, item.valor, String(pag.id)]
    ).catch(e => console.error('[/pix] Erro ao registrar pagamento:', e.message));

    // v9.2: log completo para rastreabilidade
    console.log(`[/pix] Gerado: payment_id=${pag.id} usuario_id=${usuarioId} pacote=${pacote} valor=${item.valor} external_ref=${usuarioId}|${pacote}|${item.qtd}`);
    await log(usuarioId, email, 'pix_gerado', 'ok', { payment_id: pag.id, pacote, valor: item.valor, avaliacoes: item.qtd });

    res.json({
      ok: true,
      payment_id: pag.id,
      qr_code: pixData.qr_code,
      qr_code_base64: pixData.qr_code_base64,
      valor: item.valor,
      descricao: item.descricao,
      expira_em: 30
    });
  } catch (err) {
    console.error('[/pagamento/pix]', err.message);
    res.status(500).json({ erro: 'Erro ao gerar pagamento Pix.' });
  }
});

app.post('/pagamento/reprocessar', async (req, res) => {
  try {
    const { payment_id, usuarioId } = req.body;
    if (!payment_id || !usuarioId) return res.status(400).json({ erro: 'Dados incompletos.' });
    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
    });
    const pag = await mpResp.json();

    if (pag.status !== 'approved')
      return res.json({ ok: false, status: pag.status, mensagem: 'Pagamento ainda não aprovado.' });

    const jaProcessado = await pool.query(
      `SELECT id FROM pagamentos WHERE payment_id = $1 AND status = 'aprovado'`,
      [String(payment_id)]
    );
    if (jaProcessado.rows.length > 0)
      return res.json({ ok: true, jaProcessado: true, mensagem: 'Pagamento já havia sido creditado.' });

    const pagPendente = await pool.query(
      `SELECT avaliacoes FROM pagamentos WHERE payment_id = $1 OR (usuario_id = $2 AND status = 'pendente') ORDER BY created_at DESC LIMIT 1`,
      [String(payment_id), usuarioId]
    );

    const qtd = pagPendente.rows[0]?.avaliacoes || 1;

    await pool.query(
      `UPDATE usuarios SET avaliacoes_disponiveis = COALESCE(avaliacoes_disponiveis,0) + $1, updated_at = NOW() WHERE id = $2`,
      [qtd, usuarioId]
    );

    await pool.query(
      `UPDATE pagamentos SET status='aprovado', payment_id=$1, updated_at=NOW()
       WHERE usuario_id=$2 AND status='pendente' ORDER BY created_at DESC LIMIT 1`,
      [String(payment_id), usuarioId]
    ).catch(() => {});

    const saldo = await pool.query('SELECT avaliacoes_disponiveis FROM usuarios WHERE id = $1', [usuarioId]);

    console.log(`[reprocessar] Creditado: usuario=${usuarioId}, +${qtd}, payment=${payment_id}`);
    await log(usuarioId, null, 'credito', 'ok', { origem: 'reprocessar', payment_id: String(payment_id), qtd, saldo_depois: saldo.rows[0]?.avaliacoes_disponiveis || 0 });
    res.json({
      ok: true,
      mensagem: `${qtd} avaliação(ões) creditada(s) com sucesso.`,
      avaliacoes_disponiveis: saldo.rows[0]?.avaliacoes_disponiveis || 0
    });

  } catch (err) {
    console.error('[/pagamento/reprocessar]', err.message);
    res.status(500).json({ erro: 'Erro ao reprocessar.' });
  }
});

app.get('/pagamento/status/:payment_id', async (req, res) => {
  try {
    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
    const mpResp = await fetch(`https://api.mercadopago.com/v1/payments/${req.params.payment_id}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
    });
    const pag = await mpResp.json();
    res.json({ status: pag.status, status_detail: pag.status_detail });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao verificar status.' });
  }
});

app.get('/pagamento/verificar/:payment_id', async (req, res) => {
  try {
    const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
    const resp = await fetch(`https://api.mercadopago.com/v1/payments/${req.params.payment_id}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` }
    });
    const data = await resp.json();
    res.json({ status: data.status, valor: data.transaction_amount });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao verificar pagamento.' });
  }
});

app.get('/pacotes', (req, res) => {
  res.json({ pacotes: PACOTES, pacotes_professor: PACOTES_PROFESSOR });
});

// ── ROTAS MASTER ADICIONAIS ──────────────────────────────────────────

app.get('/master/usuarios', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    const result = await pool.query(
      `SELECT id, nome, email, codigo, banca, plano, confirmado, professor,
              avaliacoes_disponiveis, total_indicacoes, total_redacoes,
              whatsapp, desconto_professor, created_at,
              COALESCE(escola, '') as tipo_instituicao,
              professor, desconto_professor
       FROM usuarios ORDER BY created_at DESC LIMIT 500`
    );
    res.json({ usuarios: result.rows });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/master/pagamentos', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    const result = await pool.query(
      `SELECT p.*, u.nome as usuario_nome, u.email as usuario_email,
              COALESCE(u.escola, '') as tipo_instituicao
       FROM pagamentos p
       LEFT JOIN usuarios u ON u.id = p.usuario_id
       ORDER BY p.created_at DESC LIMIT 1000`
    );
    res.json({ pagamentos: result.rows });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.post('/master/usuario/confirmar', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    const { email, nova_senha } = req.body;
    if (!email) return res.status(400).json({ erro: 'E-mail obrigatório.' });
    const result = await pool.query('SELECT id, nome, confirmado FROM usuarios WHERE email = $1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const u = result.rows[0];
    if (nova_senha && nova_senha.length >= 6) {
      const hash = await bcrypt.hash(nova_senha, SALT_ROUNDS);
      await pool.query(
        `UPDATE usuarios SET confirmado=TRUE, senha_hash=$1, codigo_confirmacao=NULL, codigo_expira=NULL,
         avaliacoes_disponiveis=CASE WHEN confirmado=FALSE THEN COALESCE(avaliacoes_disponiveis,0)+1
         ELSE COALESCE(avaliacoes_disponiveis,0) END, updated_at=NOW() WHERE email=$2`,
        [hash, email.toLowerCase()]
      );
      if (!u.confirmado) await log(u.id, email, 'credito', 'ok', { origem: 'master_confirmacao', qtd: 1 });
      await log(u.id, email, 'master_confirmar', 'ok', { nova_senha: true });
      res.json({ ok: true, mensagem: `Conta de ${u.nome} confirmada e senha redefinida com sucesso.` });
    } else {
      await pool.query(
        `UPDATE usuarios SET confirmado=TRUE, codigo_confirmacao=NULL, codigo_expira=NULL,
         avaliacoes_disponiveis=CASE WHEN confirmado=FALSE THEN COALESCE(avaliacoes_disponiveis,0)+1
         ELSE COALESCE(avaliacoes_disponiveis,0) END, updated_at=NOW() WHERE email=$1`,
        [email.toLowerCase()]
      );
      if (!u.confirmado) await log(u.id, email, 'credito', 'ok', { origem: 'master_confirmacao', qtd: 1 });
      await log(u.id, email, 'master_confirmar', 'ok', { nova_senha: false });
      res.json({ ok: true, mensagem: `Conta de ${u.nome} confirmada com sucesso.` });
    }
  } catch (err) {
    console.error('[master/confirmar]', err.message);
    res.status(500).json({ erro: err.message });
  }
});

app.get('/extrato/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [pagamentos, avaliacoes] = await Promise.all([
      pool.query(
        `SELECT pacote, avaliacoes, valor, status, created_at
         FROM pagamentos
         WHERE usuario_id = $1 AND status = 'aprovado'
         ORDER BY created_at DESC LIMIT 50`,
        [id]
      ),
      pool.query(
        `SELECT banca, nota_geral, created_at
         FROM avaliacoes
         WHERE usuario_id = $1
         ORDER BY created_at DESC LIMIT 100`,
        [id]
      )
    ]);
    res.json({
      pagamentos: pagamentos.rows,
      avaliacoes: avaliacoes.rows
    });
  } catch(err) {
    res.status(500).json({ erro: 'Erro ao buscar extrato.' });
  }
});

app.get('/saldo/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT avaliacoes_disponiveis, total_indicacoes, saldo, total_redacoes FROM usuarios WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar saldo.' });
  }
});


// ── TRILHA DE EVOLUÇÃO DO USUÁRIO ────────────────────────────────────
// Retorna série histórica de notas por competência para plotagem
app.get('/evolucao/:usuarioId', async (req, res) => {
  try {
    const { usuarioId } = req.params;
    const { banca } = req.query; // opcional — filtra por banca

    // Concurso agrupa CONCURSO_PUBLICO + CEBRASPE + UNB
    const bancasGrupoConcurso = ['CONCURSO_PUBLICO', 'CEBRASPE', 'UNB'];
    const isConcursoGrupo = banca === 'CONCURSO';

    const query = isConcursoGrupo
      ? `SELECT id, banca, nota_geral, resultado, created_at
         FROM avaliacoes
         WHERE usuario_id = $1 AND banca = ANY($2)
         ORDER BY created_at ASC
         LIMIT 100`
      : banca
      ? `SELECT id, banca, nota_geral, resultado, created_at
         FROM avaliacoes
         WHERE usuario_id = $1 AND banca = $2
         ORDER BY created_at ASC
         LIMIT 100`
      : `SELECT id, banca, nota_geral, resultado, created_at
         FROM avaliacoes
         WHERE usuario_id = $1
         ORDER BY created_at ASC
         LIMIT 100`;

    const params = isConcursoGrupo ? [usuarioId, bancasGrupoConcurso]
      : banca ? [usuarioId, banca.toUpperCase()] : [usuarioId];
    const result = await pool.query(query, params);

    if (!result.rows.length) {
      return res.json({
        total: 0, serie: [], competencias: {}, resumo: null
      });
    }

    // ── Montar série histórica ──────────────────────────────────────
    const serie = result.rows.map((row, idx) => {
      const res_json = typeof row.resultado === 'string'
        ? JSON.parse(row.resultado) : row.resultado || {};
      const competencias = {};
      if (Array.isArray(res_json.competencias)) {
        res_json.competencias.forEach(c => {
          competencias[c.codigo] = c.nota;
        });
      }
      return {
        numero: idx + 1,
        id: row.id,
        banca: row.banca,
        nota_geral: row.nota_geral || 0,
        competencias,
        data: row.created_at
      };
    });

    // ── Calcular médias por competência ─────────────────────────────
    const totais = {};
    const contagens = {};
    serie.forEach(s => {
      Object.entries(s.competencias).forEach(([cod, nota]) => {
        totais[cod] = (totais[cod] || 0) + nota;
        contagens[cod] = (contagens[cod] || 0) + 1;
      });
    });
    const medias = {};
    Object.keys(totais).forEach(cod => {
      medias[cod] = Math.round(totais[cod] / contagens[cod]);
    });

    // ── Tendência por competência (a partir de 2 avaliações) ─────────
    const tendencias = {};
    if (serie.length >= 2) {
      if (serie.length >= 4) {
        // Com 4+ avaliações: comparar primeira metade vs segunda metade
        const metade = Math.floor(serie.length / 2);
        const primeira = serie.slice(0, metade);
        const segunda = serie.slice(metade);
        const mediaBloco = (bloco, cod) => {
          const vals = bloco.map(s => s.competencias[cod] || 0).filter(v => v > 0);
          return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        };
        Object.keys(medias).forEach(cod => {
          const m1 = mediaBloco(primeira, cod);
          const m2 = mediaBloco(segunda, cod);
          const diff = m2 - m1;
          tendencias[cod] = diff > 5 ? 'subindo' : diff < -5 ? 'caindo' : 'estavel';
        });
      } else {
        // Com 2-3 avaliações: comparar primeira vs última
        const primeiraAv = serie[0];
        const ultimaAv = serie[serie.length - 1];
        Object.keys(medias).forEach(cod => {
          const n1 = primeiraAv.competencias[cod] || 0;
          const n2 = ultimaAv.competencias[cod] || 0;
          const diff = n2 - n1;
          tendencias[cod] = diff > 5 ? 'subindo' : diff < -5 ? 'caindo' : 'estavel';
        });
      }
    }

    // ── Identificar competência mais fraca e mais forte ─────────────
    const codsOrdenados = Object.entries(medias).sort((a, b) => a[1] - b[1]);
    const maisFragil = codsOrdenados[0]?.[0] || null;
    const maisForteCod = codsOrdenados[codsOrdenados.length - 1]?.[0] || null;

    // ── Nota geral: primeira, última, melhor, tendência geral ────────
    const notas = serie.map(s => s.nota_geral);
    const notaInicial = notas[0];
    const notaAtual = notas[notas.length - 1];
    const notaMaxima = Math.max(...notas);
    const notaMedia = Math.round(notas.reduce((a, b) => a + b, 0) / notas.length);
    const evolucaoGeral = notaAtual - notaInicial;

    // ── Bancas avaliadas ─────────────────────────────────────────────
    const bancasUsadas = [...new Set(serie.map(s => s.banca))];

    res.json({
      total: serie.length,
      serie,
      competencias: {
        medias,
        tendencias,
        mais_fragil: maisFragil,
        mais_forte: maisForteCod
      },
      resumo: {
        nota_inicial: notaInicial,
        nota_atual: notaAtual,
        nota_maxima: notaMaxima,
        nota_media: notaMedia,
        evolucao_geral: evolucaoGeral,
        bancas_usadas: bancasUsadas
      }
    });

  } catch (err) {
    console.error('[/evolucao]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar evolução.' });
  }
});

// ── SOLICITAÇÃO DE PROFESSOR ─────────────────────────────────────────
app.post('/professor/solicitar', async (req, res) => {
  try {
    const {
      usuarioId, usuarioNome, usuarioEmail,
      tipoDocumento, arquivoNome, arquivoBase64, arquivoMime,
      nivel, disciplina, instituicao
    } = req.body;

    if (!usuarioId || !usuarioNome || !usuarioEmail || !arquivoBase64)
      return res.status(400).json({ erro: 'Dados incompletos.' });

    const existe = await pool.query(
      `SELECT id FROM solicitacoes_professor WHERE usuario_id = $1 AND status = 'pendente'`,
      [usuarioId]
    );
    if (existe.rows.length > 0)
      return res.status(409).json({ erro: 'Você já possui uma solicitação em análise.' });

    await pool.query(
      `INSERT INTO solicitacoes_professor
         (usuario_id, usuario_nome, usuario_email, tipo_documento,
          arquivo_nome, arquivo_base64, arquivo_mime, nivel, disciplina, instituicao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [usuarioId, usuarioNome, usuarioEmail,
       tipoDocumento || 'CND', arquivoNome || 'documento',
       arquivoBase64, arquivoMime || 'application/pdf',
       nivel || null, disciplina || null, instituicao || null]
    );

    await pool.query(
      `UPDATE usuarios SET professor = 'pendente', updated_at = NOW() WHERE id = $1`,
      [usuarioId]
    ).catch(() => {});

    console.log(`[/professor/solicitar] Solicitação registrada: ${usuarioEmail}`);
    res.json({ ok: true, mensagem: 'Solicitação enviada! Analisaremos em até 48h úteis.' });

  } catch (err) {
    console.error('[/professor/solicitar]', err.message);
    res.status(500).json({ erro: 'Erro ao registrar solicitação.' });
  }
});

app.patch('/master/professor/:id/aprovar', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    const { nota } = req.body;
    const solId = req.params.id;

    const sol = await pool.query('SELECT * FROM solicitacoes_professor WHERE id = $1', [solId]);
    if (!sol.rows.length) return res.status(404).json({ erro: 'Solicitação não encontrada.' });
    const s = sol.rows[0];

    await pool.query(
      `UPDATE solicitacoes_professor SET status = 'aprovado', nota_operador = $1, updated_at = NOW() WHERE id = $2`,
      [nota || '', solId]
    );

    // Gerar código de confirmação para o professor aprovado
    let codigoConf = null;
    if (s.usuario_id) {
      codigoConf = Math.floor(100000 + Math.random() * 900000).toString();
      const codigoExpira = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h
      await pool.query(
        `UPDATE usuarios
         SET professor = 'aprovado', desconto_professor = TRUE,
             codigo_confirmacao = $2, codigo_expira = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [s.usuario_id, codigoConf, codigoExpira]
      );
      await log(s.usuario_id, s.usuario_email, 'professor_aprovado', 'ok',
        { solicitacao_id: solId, codigo_gerado: true });
    }

    // E-mail com código de confirmação — professor precisa confirmar para ativar conta
    try {
      const primeiroNome = s.usuario_nome.split(' ')[0];
      const ano = new Date().getFullYear();
      await enviarEmail(s.usuario_email, 'RedaCheck — Cadastro de professor aprovado! Confirme sua conta ✅', `
        <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#FAF9F7">
          <div style="text-align:center;margin-bottom:24px">
            <span style="font-size:22px;font-weight:700;letter-spacing:3px;color:#1A1A1A">REDA<span style="color:#C96A3A">CHECK</span></span>
            <div style="font-size:10px;color:#9B9080;letter-spacing:1.5px;margin-top:4px">MAIS QUE CORRIGIR — APERFEIÇOAR</div>
          </div>
          <h2 style="font-size:20px;color:#1A1A1A;margin-bottom:8px">Parabéns, ${primeiroNome}! ✅</h2>
          <p style="font-size:14px;color:#6B6255;line-height:1.7;margin-bottom:20px">
            Sua documentação foi verificada e seu <strong>Plano Professor</strong> foi <strong style="color:#16A34A">aprovado</strong>!
            Para ativar sua conta, insira o código abaixo na plataforma. Aproveite todas as funcionalidades!
          </p>
          <div style="background:#1A1A1A;border-radius:16px;padding:24px;text-align:center;margin-bottom:20px">
            <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px">Seu código de ativação</div>
            <div style="font-size:40px;font-weight:700;color:#FAF9F7;letter-spacing:8px">${codigoConf}</div>
            <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:10px">Válido por 48 horas</div>
          </div>
          <p style="font-size:12px;color:#9B9080;line-height:1.6">Acesse redacheck.com.br, clique em "Já tenho conta" e insira o código quando solicitado.</p>
          <div style="border-top:1px solid #E5E0D8;margin-top:24px;padding-top:16px;text-align:center">
            <span style="font-size:11px;color:#9B9080">© ${ano} RedaCheck — redacheck.com.br</span>
          </div>
        </div>
      `);
    } catch (emailErr) {
      console.warn('[aprovar professor] Erro e-mail:', emailErr.message);
    }

    console.log(`[/master/professor] Aprovado: ${s.usuario_email} | código gerado`);
    res.json({ ok: true, mensagem: `Professor ${s.usuario_nome} aprovado. E-mail com código enviado.` });

  } catch (err) {
    console.error('[/master/professor/aprovar]', err.message);
    res.status(500).json({ erro: 'Erro ao aprovar professor.' });
  }
});

app.patch('/master/professor/:id/recusar', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    const { nota } = req.body;
    const solId = req.params.id;

    const sol = await pool.query('SELECT * FROM solicitacoes_professor WHERE id = $1', [solId]);
    if (!sol.rows.length) return res.status(404).json({ erro: 'Solicitação não encontrada.' });
    const s = sol.rows[0];

    await pool.query(
      `UPDATE solicitacoes_professor SET status = 'recusado', nota_operador = $1, updated_at = NOW() WHERE id = $2`,
      [nota || '', solId]
    );

    if (s.usuario_id) {
      await pool.query(
        `UPDATE usuarios SET professor = 'recusado', updated_at = NOW() WHERE id = $1`,
        [s.usuario_id]
      );
    }

    try {
      const primeiroNome = s.usuario_nome.split(' ')[0];
      const motivo = nota || 'Documento não atende aos requisitos solicitados.';
      await enviarEmail(s.usuario_email, 'RedaCheck — Sobre sua solicitação de professor', `
        <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#FAF9F7">
          <div style="text-align:center;margin-bottom:24px">
            <span style="font-size:22px;font-weight:700;letter-spacing:3px;color:#1A1A1A">REDA<span style="color:#C96A3A">CHECK</span></span>
          </div>
          <h2 style="font-size:20px;color:#1A1A1A;margin-bottom:12px">Olá, ${primeiroNome}</h2>
          <p style="font-size:14px;color:#6B6255;line-height:1.7;margin-bottom:16px">
            Analisamos sua solicitação de <strong>Plano Professor</strong> e, no momento,
            não foi possível aprová-la pelo seguinte motivo:
          </p>
          <div style="background:#FEF3EC;border-left:4px solid #C96A3A;border-radius:10px;padding:14px 16px;margin-bottom:20px">
            <div style="font-size:13px;color:#6B6255;line-height:1.6">${motivo}</div>
          </div>
          <p style="font-size:14px;color:#6B6255;line-height:1.7;margin-bottom:16px">
            Você pode reenviar sua solicitação com um dos documentos aceitos:
            <strong>CND</strong>, <strong>declaração institucional com assinatura digital</strong>
            ou <strong>contracheque</strong> com vínculo docente ativo.
          </p>
          <p style="font-size:12px;color:#9B9080;line-height:1.6">Dúvidas? Entre em contato: contato@redacheck.com.br</p>
          <div style="border-top:1px solid #E5E0D8;margin-top:24px;padding-top:16px;text-align:center">
            <span style="font-size:11px;color:#9B9080">© ${new Date().getFullYear()} RedaCheck — redacheck.com.br</span>
          </div>
        </div>
      `);
    } catch (emailErr) {
      console.warn('[recusar professor] Erro e-mail:', emailErr.message);
    }

    console.log(`[/master/professor] Recusado: ${s.usuario_email}`);
    res.json({ ok: true, mensagem: `Solicitação de ${s.usuario_nome} recusada.` });

  } catch (err) {
    console.error('[/master/professor/recusar]', err.message);
    res.status(500).json({ erro: 'Erro ao recusar solicitação.' });
  }
});

// ── MASTER: APROVAR FEEDBACK PARA HOME ──────────────────────────────
app.patch('/master/feedback/:id/aprovar', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Não autorizado.' });
  try {
    const { aprovado } = req.body;
    await pool.query(
      `UPDATE feedbacks SET aprovado = $1 WHERE id = $2`,
      [aprovado !== false, req.params.id]
    );
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ erro: 'Erro ao atualizar feedback.' });
  }
});

// ── MASTER: CREDITAR AVALIAÇÕES MANUALMENTE ─────────────────────────
app.post('/master/creditar', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    const { usuarioId, qtd, motivo } = req.body;
    if (!usuarioId || !qtd) return res.status(400).json({ erro: 'usuarioId e qtd são obrigatórios.' });
    const quantidade = parseInt(qtd);
    if (isNaN(quantidade) || quantidade < 1 || quantidade > 100)
      return res.status(400).json({ erro: 'Quantidade inválida. Use entre 1 e 100.' });

    // Buscar usuário antes de creditar (para log com saldo_antes)
    const uBefore = await pool.query(
      'SELECT id, nome, email, avaliacoes_disponiveis FROM usuarios WHERE id = $1',
      [usuarioId]
    );
    if (!uBefore.rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const u = uBefore.rows[0];
    const saldoAntes = u.avaliacoes_disponiveis || 0;

    // Creditar
    await pool.query(
      `UPDATE usuarios SET avaliacoes_disponiveis = COALESCE(avaliacoes_disponiveis,0) + $1, updated_at = NOW() WHERE id = $2`,
      [quantidade, usuarioId]
    );

    const saldoDepois = saldoAntes + quantidade;

    // Registrar em logs_usuario
    await log(usuarioId, u.email, 'credito', 'ok', {
      origem: 'master_credito_manual',
      qtd: quantidade,
      motivo: motivo || 'Crédito manual pelo operador',
      saldo_antes: saldoAntes,
      saldo_depois: saldoDepois
    });

    console.log(`[master/creditar] +${quantidade} para usuario_id=${usuarioId} (${u.email}) | motivo: ${motivo || '-'} | saldo: ${saldoAntes} → ${saldoDepois}`);

    res.json({
      ok: true,
      mensagem: `${quantidade} avaliação(ões) creditada(s) para ${u.nome}.`,
      usuario: { id: u.id, nome: u.nome, email: u.email, saldo_antes: saldoAntes, saldo_depois: saldoDepois }
    });
  } catch (err) {
    console.error('[master/creditar]', err.message);
    res.status(500).json({ erro: 'Erro ao creditar avaliações.' });
  }
});

// ── MASTER: LOGS DE USUÁRIO ──────────────────────────────────────────
app.get('/master/logs/:usuarioId', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    const { usuarioId } = req.params;
    const { limit = 100 } = req.query;
    const result = await pool.query(
      `SELECT id, usuario_id, email, acao, status, detalhes, ip, created_at
       FROM logs_usuario
       WHERE usuario_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [usuarioId, parseInt(limit)]
    );
    res.json({ logs: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// Buscar logs por e-mail (quando não se sabe o id)
app.get('/master/logs/email/:email', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    const result = await pool.query(
      `SELECT l.id, l.usuario_id, l.email, l.acao, l.status, l.detalhes, l.ip, l.created_at
       FROM logs_usuario l
       WHERE l.email = $1 OR l.usuario_id = (SELECT id FROM usuarios WHERE email = $1 LIMIT 1)
       ORDER BY l.created_at DESC
       LIMIT 200`,
      [req.params.email.toLowerCase()]
    );
    res.json({ logs: result.rows, total: result.rows.length });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/master/solicitacoes-professor', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    const result = await pool.query(
      `SELECT id, usuario_id, usuario_nome, usuario_email, tipo_documento,
              arquivo_nome, arquivo_mime, nivel, disciplina, instituicao,
              status, nota_operador, created_at
       FROM solicitacoes_professor
       ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ solicitacoes: result.rows });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

app.get('/master/solicitacoes-professor/:id/arquivo', async (req, res) => {
  const token = req.headers['x-master-token'];
  if (token !== MASTER_TOKEN) return res.status(401).json({ erro: 'Acesso não autorizado.' });
  try {
    const result = await pool.query(
      'SELECT arquivo_base64, arquivo_mime, arquivo_nome FROM solicitacoes_professor WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ erro: 'Não encontrado.' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// ── CHAT REDA ─────────────────────────────────────────────────────────
const REDA_SISTEMA = `Você é a Reda, assistente virtual do RedaCheck. É amigável, pedagógica, direta e especialista em redações dissertativas-argumentativas e no ensino de Língua Portuguesa.

SOBRE O REDACHECK:
- Plataforma brasileira de avaliação inteligente de redações com IA
- Fundamentada nas gramáticas de Cegalla, Celso Cunha & Cintra, Marcuschi e Irandé Antunes
- Avalia para ENEM, ITA, Unicamp, Fuvest/USP e Concursos Públicos
- Preço: R$ 4,90/avaliação. Pacotes: 5 por R$19,90 (19%), 10 por R$34,90 (29%), 20 por R$68,60 (30%)
- 1 redação bônus gratuita no cadastro
- Programa de indicação: a cada 10 indicados confirmados = 1 bônus (máx. 3 bônus)
- Professores com CND, declaração institucional ou contracheque: 50% de desconto
- Site: redacheck.com.br

CRITÉRIOS ENEM — 5 COMPETÊNCIAS:
C1 (0–200) — Domínio da modalidade escrita formal da Língua Portuguesa
C2 (0–200) — Compreensão da proposta e repertório sociocultural produtivo
C3 (0–200) — Seleção e organização de argumentos em defesa de um ponto de vista
C4 (0–200) — Mecanismos linguísticos de coesão textual
C5 (0–200) — Proposta de intervenção com respeito aos direitos humanos
→ C5 exige 5 elementos obrigatórios: agente + ação + modo/meio + finalidade + efeito esperado
→ Proposta vaga ou incompleta = nota penalizada; desrespeito aos DH = nota 0 na C5

PAULO FREIRE E O REDACHECK:
- Paulo Freire é a referência filosófico-pedagógica central da plataforma.
- Obra principal no contexto do RedaCheck: "A Importância do Ato de Ler" (1989).
- Conceito central: "A leitura do mundo precede a leitura da palavra" — escrever bem é pensar o mundo com clareza.
- Quando o usuário perguntar sobre Freire, sobre leitura ou sobre a filosofia da plataforma, cite este conceito com naturalidade.
- O feedback do RedaCheck é dialógico, não punitivo — inspirado diretamente em Freire.

REGRAS DE COMPORTAMENTO:
- Responda SEMPRE em português brasileiro culto e acessível
- Respostas de até 4 parágrafos curtos e objetivos
- Nunca invente critérios, preços ou regras`;

app.post('/chat', async (req, res) => {
  try {
    const { mensagens, usuario } = req.body;
    if (!mensagens || !Array.isArray(mensagens) || mensagens.length === 0)
      return res.status(400).json({ erro: 'Mensagens obrigatórias.' });

    const historico = mensagens.slice(-20);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        system: REDA_SISTEMA,
        messages: historico
      })
    });

    const data = await response.json();

    if (data.error) {
      console.error('[/chat] Erro API:', data.error.message);
      return res.status(500).json({ erro: 'Erro na API de chat.' });
    }

    const resposta = data.content?.[0]?.text || 'Desculpe, não consegui processar sua mensagem.';
    console.log(`[/chat] usuario=${usuario||'?'} msgs=${historico.length}`);

    res.json({ resposta });
  } catch (err) {
    console.error('[/chat]', err.message);
    res.status(500).json({ erro: 'Erro interno no chat.' });
  }
});

const _dicaCache = new Map();
function _getCacheDica(key) {
  const entry = _dicaCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > 10 * 60 * 1000) { _dicaCache.delete(key); return null; }
  return entry.data;
}
function _setCacheDica(key, data) {
  _dicaCache.set(key, { data, ts: Date.now() });
  if (_dicaCache.size > 100) {
    const firstKey = _dicaCache.keys().next().value;
    _dicaCache.delete(firstKey);
  }
}

const CATEGORIAS_DICA = [
  'norma-padrão e gramática',
  'argumentação e estrutura dissertativa',
  'repertório sociocultural produtivo',
  'proposta de intervenção C5 ENEM',
  'conectivos e coesão textual',
  'especificidades da banca'
];

app.get('/dica', async (req, res) => {
  try {
    const banca = (req.query.banca || 'ENEM').toUpperCase();
    const categoria = req.query.categoria ||
      CATEGORIAS_DICA[Math.floor(Math.random() * CATEGORIAS_DICA.length)];

    const cacheKey = `${banca}:${categoria}`;
    const cached = _getCacheDica(cacheKey);
    if (cached) {
      console.log(`[/dica] cache hit: ${cacheKey}`);
      return res.json({ dica: cached, categorias: CATEGORIAS_DICA, fromCache: true });
    }

    const prompt = `Você é a Reda, assistente pedagógica do RedaCheck. Gere UMA dica prática e objetiva sobre "${categoria}" para redações da banca ${banca}.

FORMATO OBRIGATÓRIO — responda apenas com JSON válido:
{
  "titulo": "<título curto da dica, máx 8 palavras>",
  "categoria": "${categoria}",
  "dica": "<dica em 2-3 frases práticas, diretas, com exemplo quando possível>",
  "atencao": "<1 erro comum relacionado ao tema que o estudante deve evitar>",
  "referencia": "<obra e autor da base RedaCheck que fundamenta esta dica>"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        system: 'Responda APENAS com JSON válido, sem markdown, sem texto adicional.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ erro: 'Erro na API.' });

    let dica;
    try {
      let texto = data.content[0].text.trim();
      const s = texto.indexOf('{'); const e = texto.lastIndexOf('}');
      if (s >= 0 && e > s) texto = texto.substring(s, e + 1);
      dica = JSON.parse(texto);
    } catch {
      return res.status(500).json({ erro: 'Erro ao processar dica.' });
    }

    _setCacheDica(cacheKey, dica);
    console.log(`[/dica] banca=${banca} categoria=${categoria}`);
    res.json({ dica, categorias: CATEGORIAS_DICA, fromCache: false });

  } catch (err) {
    console.error('[/dica]', err.message);
    res.status(500).json({ erro: 'Erro interno.' });
  }
});

app.get('/historico-chat/:codigo', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.mensagens, c.data_inicio, c.duracao
       FROM conversas c
       JOIN usuarios u ON u.nome = c.usuario
       WHERE u.codigo = $1
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [req.params.codigo]
    );
    if (!result.rows.length) return res.json({ mensagens: [] });
    res.json({ mensagens: result.rows[0].mensagens || [] });
  } catch (err) {
    console.error('[/historico-chat]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar histórico.' });
  }
});

app.get('/bancas', (req, res) => {
  res.json({
    bancas: [
      { id: 'ENEM', nome: 'ENEM', descricao: 'Exame Nacional do Ensino Médio', maxPontos: 1000 },
      { id: 'ITA', nome: 'ITA', descricao: 'Instituto Tecnológico de Aeronáutica', maxPontos: 1000 },
      { id: 'UNICAMP', nome: 'Unicamp', descricao: 'Universidade Estadual de Campinas', maxPontos: 12 },
      { id: 'FUVEST', nome: 'Fuvest / USP', descricao: 'Fundação Universitária para o Vestibular', maxPontos: 100 },
      { id: 'CONCURSO_PUBLICO', nome: 'Concurso Público', descricao: 'CESPE, FGV, FCC e outras bancas', maxPontos: 100 },
      { id: 'UNB', nome: 'UnB', descricao: 'Vestibular da Universidade de Brasília — NR = NC – 2×(NE÷TL)', maxPontos: 1000 },
      { id: 'CEBRASPE', nome: 'CEBRASPE', descricao: 'Concurso Público CEBRASPE/UnB — NPD = NC – 6×(NE÷TL)', maxPontos: 1000 }
    ]
  });
});

// ── INICIALIZAR ───────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
inicializarBanco().then(() => {
  app.listen(PORT, () => console.log(`RedaCheck API v9.10 | porta ${PORT} | cache duplicatas + logs + trilha evolução`));
});
