// ============================================================
// SISTEMA DE GESTÃO ESCOLAR CEMIC — Backend v3.11 (… + Portal dos Pais + Pix Inter)
// Banco + Autenticação com perfis + Configurações + CRUDs
// Stack: Node.js/Express + PostgreSQL (Railway)
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---------- Variáveis de ambiente obrigatórias ----------
const { DATABASE_URL, JWT_SECRET } = process.env;
if (!DATABASE_URL) { console.error('ERRO: DATABASE_URL não definida.'); process.exit(1); }
if (!JWT_SECRET) { console.error('ERRO: JWT_SECRET não definida.'); process.exit(1); }

const MASTER_CPF = process.env.MASTER_CPF || '00000000000';
const MASTER_SENHA = process.env.MASTER_SENHA || null; // se ausente, master só é criado se já houver senha definida

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ============================================================
// 1. CRIAÇÃO DO BANCO (idempotente — CREATE IF NOT EXISTS)
// ============================================================
async function initDB() {
  const ddl = `
  -- ---------- Configurações e autenticação ----------
  CREATE TABLE IF NOT EXISTS configuracoes (
    id SERIAL PRIMARY KEY,
    chave TEXT UNIQUE NOT NULL,
    valor JSONB NOT NULL,
    descricao TEXT,
    atualizado_em TIMESTAMP DEFAULT NOW(),
    atualizado_por INTEGER
  );

  CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    cpf TEXT UNIQUE NOT NULL,
    email TEXT,
    whatsapp TEXT,
    senha_hash TEXT NOT NULL,
    data_nascimento DATE,
    perfil TEXT NOT NULL CHECK (perfil IN ('master','secretaria','professor','aluno','responsavel')),
    referencia_id INTEGER,
    status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','inativo')),
    senha_provisoria BOOLEAN DEFAULT FALSE,
    criado_em TIMESTAMP DEFAULT NOW(),
    ultimo_acesso TIMESTAMP
  );

  -- ---------- Pessoas ----------
  CREATE TABLE IF NOT EXISTS alunos (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    data_nascimento DATE,
    email TEXT,
    cpf TEXT UNIQUE,
    whatsapp TEXT,
    status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','inativo')),
    modalidade TEXT NOT NULL DEFAULT 'pagante' CHECK (modalidade IN ('pagante','pagante_parcial','bolsista')),
    desconto_percentual NUMERIC(5,2) NOT NULL DEFAULT 0,
    data_cadastro DATE DEFAULT CURRENT_DATE,
    observacoes TEXT
  );

  CREATE TABLE IF NOT EXISTS responsaveis (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    cpf TEXT UNIQUE NOT NULL,
    email TEXT,
    whatsapp TEXT
  );

  CREATE TABLE IF NOT EXISTS aluno_responsavel (
    id SERIAL PRIMARY KEY,
    aluno_id INTEGER NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
    responsavel_id INTEGER NOT NULL REFERENCES responsaveis(id) ON DELETE CASCADE,
    parentesco TEXT,
    responsavel_financeiro BOOLEAN DEFAULT FALSE,
    UNIQUE(aluno_id, responsavel_id)
  );

  CREATE TABLE IF NOT EXISTS professores (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    email TEXT,
    formacao TEXT,
    whatsapp TEXT,
    data_nascimento DATE,
    status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','inativo'))
  );

  -- ---------- Acadêmico ----------
  CREATE TABLE IF NOT EXISTS cursos (
    id SERIAL PRIMARY KEY,
    nome TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','inativo'))
  );

  CREATE TABLE IF NOT EXISTS niveis (
    id SERIAL PRIMARY KEY,
    curso_id INTEGER NOT NULL REFERENCES cursos(id),
    nome TEXT NOT NULL,
    ordem INTEGER NOT NULL DEFAULT 1,
    carga_horaria INTEGER,
    UNIQUE(curso_id, nome)
  );

  CREATE TABLE IF NOT EXISTS turmas (
    id SERIAL PRIMARY KEY,
    nivel_id INTEGER NOT NULL REFERENCES niveis(id),
    nome TEXT NOT NULL,
    semestre TEXT NOT NULL,
    turno TEXT,
    horario TEXT,
    professor_id INTEGER REFERENCES professores(id),
    capacidade INTEGER NOT NULL DEFAULT 15,
    status TEXT NOT NULL DEFAULT 'em_formacao' CHECK (status IN ('em_formacao','em_andamento','encerrada')),
    UNIQUE(nome, semestre)
  );

  CREATE TABLE IF NOT EXISTS matriculas (
    id SERIAL PRIMARY KEY,
    aluno_id INTEGER NOT NULL REFERENCES alunos(id),
    turma_id INTEGER NOT NULL REFERENCES turmas(id),
    data_matricula DATE DEFAULT CURRENT_DATE,
    valor_mensalidade NUMERIC(10,2) NOT NULL DEFAULT 0,
    desconto_aplicado NUMERIC(5,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','trancada','cancelada','concluida')),
    resultado TEXT CHECK (resultado IN ('aprovado','reprovado')),
    media_final NUMERIC(5,2),
    frequencia_final NUMERIC(5,2),
    UNIQUE(aluno_id, turma_id)
  );

  CREATE TABLE IF NOT EXISTS avaliacoes (
    id SERIAL PRIMARY KEY,
    turma_id INTEGER NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    peso NUMERIC(5,2) NOT NULL DEFAULT 1,
    data DATE
  );

  CREATE TABLE IF NOT EXISTS notas (
    id SERIAL PRIMARY KEY,
    avaliacao_id INTEGER NOT NULL REFERENCES avaliacoes(id) ON DELETE CASCADE,
    matricula_id INTEGER NOT NULL REFERENCES matriculas(id) ON DELETE CASCADE,
    nota NUMERIC(5,2) NOT NULL,
    lancada_por INTEGER REFERENCES usuarios(id),
    lancada_em TIMESTAMP DEFAULT NOW(),
    UNIQUE(avaliacao_id, matricula_id)
  );

  CREATE TABLE IF NOT EXISTS aulas (
    id SERIAL PRIMARY KEY,
    turma_id INTEGER NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
    data DATE NOT NULL,
    conteudo TEXT
  );

  CREATE TABLE IF NOT EXISTS frequencias (
    id SERIAL PRIMARY KEY,
    aula_id INTEGER NOT NULL REFERENCES aulas(id) ON DELETE CASCADE,
    matricula_id INTEGER NOT NULL REFERENCES matriculas(id) ON DELETE CASCADE,
    presente BOOLEAN NOT NULL DEFAULT TRUE,
    justificativa TEXT,
    UNIQUE(aula_id, matricula_id)
  );

  -- ---------- Financeiro ----------
  CREATE TABLE IF NOT EXISTS fornecedores (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    cpf_cnpj TEXT,
    email TEXT,
    whatsapp TEXT,
    categoria TEXT,
    observacoes TEXT,
    status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','inativo'))
  );

  CREATE TABLE IF NOT EXISTS contas_pagar (
    id SERIAL PRIMARY KEY,
    fornecedor_id INTEGER REFERENCES fornecedores(id),
    descricao TEXT NOT NULL,
    categoria TEXT,
    valor NUMERIC(10,2) NOT NULL,
    vencimento DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','paga','atrasada','cancelada')),
    data_pagamento DATE,
    forma_pagamento TEXT,
    comprovante_url TEXT,
    criado_por INTEGER REFERENCES usuarios(id),
    criado_em TIMESTAMP DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS contas_receber (
    id SERIAL PRIMARY KEY,
    aluno_id INTEGER NOT NULL REFERENCES alunos(id),
    matricula_id INTEGER REFERENCES matriculas(id),
    descricao TEXT NOT NULL,
    competencia TEXT,
    valor_original NUMERIC(10,2) NOT NULL,
    desconto NUMERIC(10,2) NOT NULL DEFAULT 0,
    valor_final NUMERIC(10,2) NOT NULL,
    vencimento DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','paga','atrasada','cancelada')),
    data_pagamento DATE,
    forma_pagamento TEXT,
    recebido_por INTEGER REFERENCES usuarios(id),
    criado_em TIMESTAMP DEFAULT NOW()
  );

  -- ---------- Comunicação ----------
  CREATE TABLE IF NOT EXISTS avisos (
    id SERIAL PRIMARY KEY,
    autor_id INTEGER REFERENCES usuarios(id),
    escopo TEXT NOT NULL DEFAULT 'geral' CHECK (escopo IN ('geral','turma','aluno')),
    turma_id INTEGER REFERENCES turmas(id) ON DELETE CASCADE,
    aluno_id INTEGER REFERENCES alunos(id) ON DELETE CASCADE,
    titulo TEXT NOT NULL,
    mensagem TEXT NOT NULL,
    criado_em TIMESTAMP DEFAULT NOW()
  );
  `;
  await pool.query(ddl);
  // Migrações (idempotentes): desconto em R$ e pontualidade
  await pool.query(`ALTER TABLE alunos ADD COLUMN IF NOT EXISTS desconto_valor NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE matriculas ALTER COLUMN desconto_aplicado TYPE NUMERIC(10,2)`);
  await pool.query(`ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS desconto_pontualidade NUMERIC(10,2) NOT NULL DEFAULT 0`);

  // ---------- Migrações — Módulo Financeiro v3.9 ----------
  // Código de identificação por entidade (determinístico a partir do id) + backfill dos existentes
  await pool.query(`ALTER TABLE alunos       ADD COLUMN IF NOT EXISTS codigo TEXT`);
  await pool.query(`ALTER TABLE professores  ADD COLUMN IF NOT EXISTS codigo TEXT`);
  await pool.query(`ALTER TABLE usuarios     ADD COLUMN IF NOT EXISTS codigo TEXT`);
  await pool.query(`ALTER TABLE fornecedores ADD COLUMN IF NOT EXISTS codigo TEXT`);
  await pool.query(`UPDATE alunos       SET codigo = 'ALU-' || lpad(id::text, 4, '0') WHERE codigo IS NULL`);
  await pool.query(`UPDATE professores  SET codigo = 'PRF-' || lpad(id::text, 4, '0') WHERE codigo IS NULL`);
  await pool.query(`UPDATE usuarios     SET codigo = 'USR-' || lpad(id::text, 4, '0') WHERE codigo IS NULL`);
  await pool.query(`UPDATE fornecedores SET codigo = 'FRN-' || lpad(id::text, 4, '0') WHERE codigo IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alunos_codigo       ON alunos(codigo)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_professores_codigo  ON professores(codigo)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_codigo     ON usuarios(codigo)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fornecedores_codigo ON fornecedores(codigo)`);

  // Contas a Receber: documento, juros, valor recebido e cliente livre; aluno_id passa a ser opcional (avulsa)
  await pool.query(`ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS numero_documento TEXT`);
  await pool.query(`ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS juros NUMERIC(10,2) NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS valor_recebido NUMERIC(10,2)`);
  await pool.query(`ALTER TABLE contas_receber ADD COLUMN IF NOT EXISTS cliente_nome TEXT`);
  await pool.query(`ALTER TABLE contas_receber ALTER COLUMN aluno_id DROP NOT NULL`);
  await pool.query(`UPDATE contas_receber SET numero_documento = 'CR-' || to_char(COALESCE(criado_em, NOW()), 'YYYY') || '-' || lpad(id::text, 6, '0') WHERE numero_documento IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contas_receber_documento ON contas_receber(numero_documento)`);

  // Geração automática de código/documento em novas inserções.
  // AFTER INSERT + UPDATE: o NEW.id é garantido nesse ponto, sem depender da ordem
  // de avaliação de DEFAULT em BEFORE INSERT — abordagem à prova de falhas.
  await pool.query(`CREATE OR REPLACE FUNCTION gera_codigo() RETURNS trigger AS $func$
    BEGIN
      IF NEW.codigo IS NULL THEN
        EXECUTE format('UPDATE %I SET codigo = $1 WHERE id = $2', TG_TABLE_NAME)
          USING TG_ARGV[0] || lpad(NEW.id::text, 4, '0'), NEW.id;
      END IF;
      RETURN NULL;
    END; $func$ LANGUAGE plpgsql`);
  await pool.query(`CREATE OR REPLACE FUNCTION gera_documento_cr() RETURNS trigger AS $func$
    BEGIN
      IF NEW.numero_documento IS NULL THEN
        UPDATE contas_receber
          SET numero_documento = 'CR-' || to_char(COALESCE(NEW.criado_em, NOW()), 'YYYY') || '-' || lpad(NEW.id::text, 6, '0')
          WHERE id = NEW.id;
      END IF;
      RETURN NULL;
    END; $func$ LANGUAGE plpgsql`);
  for (const [tab, pref] of [['alunos', 'ALU-'], ['professores', 'PRF-'], ['usuarios', 'USR-'], ['fornecedores', 'FRN-']]) {
    await pool.query(`DROP TRIGGER IF EXISTS trg_codigo_${tab} ON ${tab}`);
    await pool.query(`CREATE TRIGGER trg_codigo_${tab} AFTER INSERT ON ${tab} FOR EACH ROW EXECUTE FUNCTION gera_codigo('${pref}')`);
  }
  await pool.query(`DROP TRIGGER IF EXISTS trg_documento_cr ON contas_receber`);
  await pool.query(`CREATE TRIGGER trg_documento_cr AFTER INSERT ON contas_receber FOR EACH ROW EXECUTE FUNCTION gera_documento_cr()`);

  // ---------- Portal dos Pais — Pré-inscrições (v3.10) ----------
  await pool.query(`CREATE TABLE IF NOT EXISTS pre_inscricoes (
    id SERIAL PRIMARY KEY,
    protocolo TEXT,
    aluno_nome TEXT NOT NULL,
    aluno_data_nascimento DATE,
    aluno_cpf TEXT,
    programa TEXT,
    turno TEXT,
    responsavel_nome TEXT NOT NULL,
    responsavel_cpf TEXT,
    responsavel_whatsapp TEXT,
    responsavel_email TEXT,
    parentesco TEXT,
    valor_taxa NUMERIC(10,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'aguardando_pagamento'
      CHECK (status IN ('aguardando_pagamento','pago','cancelada','efetivada')),
    mp_payment_id TEXT,
    pix_qr TEXT,
    pix_copia_cola TEXT,
    aluno_id INTEGER REFERENCES alunos(id),
    matricula_id INTEGER REFERENCES matriculas(id),
    observacoes TEXT,
    criado_em TIMESTAMPTZ DEFAULT NOW(),
    pago_em TIMESTAMPTZ
  )`);
  await seedConfiguracoes();
  await seedCursosNiveis();
  await seedMaster();
  console.log('Banco verificado/criado com sucesso.');
}

// ---------- Seeds de configurações padrão ----------
async function seedConfiguracoes() {
  const padroes = [
    ['semestre_vigente', JSON.stringify('2026.2'), 'Semestre letivo vigente (formato AAAA.S)'],
    ['capacidade_padrao_turma', JSON.stringify(15), 'Capacidade padrão de alunos por turma (ajustável por turma)'],
    ['media_aprovacao', JSON.stringify(7), 'Média mínima para aprovação (0 a 10)'],
    ['frequencia_minima', JSON.stringify(75), 'Frequência mínima para aprovação (%)'],
    ['parcelas_semestre', JSON.stringify(6), 'Quantidade de mensalidades geradas por matrícula no semestre'],
    ['dia_vencimento', JSON.stringify(10), 'Dia padrão de vencimento das mensalidades'],
    ['taxa_matricula', JSON.stringify(0), 'Valor padrão da taxa de matrícula (R$) — ajustável no ato, paga sempre no ato'],
    ['valor_plataforma', JSON.stringify(25), 'Valor da Taxa da Plataforma Acadêmica (R$) — lançada 1x por semestre'],
    ['desconto_pontualidade', JSON.stringify(0), 'Desconto de pontualidade (R$) abatido da mensalidade paga até o vencimento'],
    ['multa_atraso', JSON.stringify({ ativa: false, multa_percentual: 2, juros_dia_percentual: 0.033 }), 'Multa e juros por atraso (aplicados quando ativa = true)'],
    ['descontos_disponiveis', JSON.stringify([25, 50, 100]), 'Percentuais de desconto disponíveis para Pagante Parcial (bolsista = 100)'],
    ['mensalidades', JSON.stringify({ 'Inglês': 0, 'Espanhol': 0 }), 'Valor da mensalidade integral por curso (R$) — definir antes das matrículas'],
    ['formas_pagamento', JSON.stringify(['PIX', 'DINHEIRO', 'CARTÃO DE CRÉDITO', 'CARTÃO DE DÉBITO', 'TRANSFERÊNCIA', 'MISTO']), 'Formas de pagamento aceitas'],
    ['categorias_contas_pagar', JSON.stringify(['Aluguel', 'Energia', 'Água/Internet', 'Salários', 'Material Didático', 'Manutenção', 'Outros']), 'Categorias de contas a pagar'],
    ['categorias_contas_receber', JSON.stringify(['Mensalidade', 'Matrícula', 'Material', 'Evento', 'Outros']), 'Categorias de contas a receber'],
    ['dados_instituicao', JSON.stringify({
      nome: 'CEMIC — Centro Maranhense de Idiomas e Culturas',
      cnpj: '', endereco: 'São Luís - MA', telefone: '', email: '', logo_url: ''
    }), 'Dados institucionais usados em documentos e PDFs'],
    ['modelo_boletim', JSON.stringify({ titulo: 'Boletim de Desempenho', exibir_frequencia: true, exibir_observacoes: true, rodape: 'Documento emitido pelo CEMIC.' }), 'Modelo do boletim do aluno'],
    ['modelo_historico', JSON.stringify({ titulo: 'Histórico Escolar', exibir_carga_horaria: true, rodape: 'Documento emitido pelo CEMIC.' }), 'Modelo do histórico do aluno']
  ];
  for (const [chave, valor, descricao] of padroes) {
    await pool.query(
      `INSERT INTO configuracoes (chave, valor, descricao) VALUES ($1, $2, $3) ON CONFLICT (chave) DO NOTHING`,
      [chave, valor, descricao]
    );
  }
}

// ---------- Seeds de cursos e níveis ----------
async function seedCursosNiveis() {
  const cursos = ['Inglês', 'Espanhol'];
  const niveis = ['Kids', 'Basic', 'Pre-Intermediate', 'Intermediate', 'Advanced'];
  for (const nomeCurso of cursos) {
    const c = await pool.query(
      `INSERT INTO cursos (nome) VALUES ($1) ON CONFLICT (nome) DO UPDATE SET nome = EXCLUDED.nome RETURNING id`,
      [nomeCurso]
    );
    const cursoId = c.rows[0].id;
    for (let i = 0; i < niveis.length; i++) {
      await pool.query(
        `INSERT INTO niveis (curso_id, nome, ordem) VALUES ($1, $2, $3) ON CONFLICT (curso_id, nome) DO NOTHING`,
        [cursoId, niveis[i], i + 1]
      );
    }
  }
}

// ---------- Bootstrap do usuário master ----------
async function seedMaster() {
  const existe = await pool.query(`SELECT id FROM usuarios WHERE perfil = 'master' LIMIT 1`);
  if (existe.rows.length > 0) return;
  if (!MASTER_SENHA) {
    console.warn('AVISO: nenhum usuário master existe e MASTER_SENHA não foi definida. Defina MASTER_CPF e MASTER_SENHA nas variáveis do Railway e reinicie.');
    return;
  }
  const hash = await bcrypt.hash(MASTER_SENHA, 10);
  await pool.query(
    `INSERT INTO usuarios (nome, cpf, senha_hash, perfil, status) VALUES ($1, $2, $3, 'master', 'ativo')`,
    ['Paulo (Master)', MASTER_CPF, hash]
  );
  console.log('Usuário master criado a partir das variáveis de ambiente.');
}

// ============================================================
// 2. AUTENTICAÇÃO E MIDDLEWARES
// ============================================================
const limiterLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { erro: 'Muitas tentativas de login. Aguarde 15 minutos.' }
});

const limiterPublico = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Aguarde alguns instantes e tente novamente.' }
});

function autenticar(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Token não fornecido.' });
  try {
    req.usuario = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ erro: 'Token inválido ou expirado.' });
  }
}

function exigirPerfil(...perfis) {
  return (req, res, next) => {
    if (!perfis.includes(req.usuario.perfil)) {
      return res.status(403).json({ erro: 'Acesso negado para o seu perfil.' });
    }
    next();
  };
}

const somenteGestao = exigirPerfil('master', 'secretaria');

function obrigatorios(body, campos) {
  const faltando = campos.filter(c => body[c] === undefined || body[c] === null || body[c] === '');
  return faltando.length ? `Campos obrigatórios ausentes: ${faltando.join(', ')}` : null;
}

const soDigitos = (s) => String(s || '').replace(/\D/g, '');

// Validação matemática de CPF (dígitos verificadores)
function cpfValido(cpf) {
  cpf = soDigitos(cpf);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let s = 0;
  for (let i = 0; i < 9; i++) s += Number(cpf[i]) * (10 - i);
  if ((s * 10) % 11 % 10 !== Number(cpf[9])) return false;
  s = 0;
  for (let i = 0; i < 10; i++) s += Number(cpf[i]) * (11 - i);
  return (s * 10) % 11 % 10 === Number(cpf[10]);
}

// ---------- POST /auth/login ----------
app.post('/auth/login', limiterLogin, async (req, res) => {
  try {
    const erro = obrigatorios(req.body, ['cpf', 'senha']);
    if (erro) return res.status(400).json({ erro });
    const cpf = soDigitos(req.body.cpf);
    const r = await pool.query(`SELECT * FROM usuarios WHERE cpf = $1`, [cpf]);
    const u = r.rows[0];
    if (!u || u.status !== 'ativo') return res.status(401).json({ erro: 'CPF ou senha inválidos.' });
    const ok = await bcrypt.compare(req.body.senha, u.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'CPF ou senha inválidos.' });
    await pool.query(`UPDATE usuarios SET ultimo_acesso = NOW() WHERE id = $1`, [u.id]);
    const token = jwt.sign(
      { id: u.id, nome: u.nome, perfil: u.perfil, referencia_id: u.referencia_id },
      JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({
      token,
      usuario: { id: u.id, nome: u.nome, perfil: u.perfil, senha_provisoria: u.senha_provisoria }
    });
  } catch (e) {
    console.error('Erro /auth/login:', e);
    res.status(500).json({ erro: 'Erro interno no login.' });
  }
});

// ---------- POST /auth/trocar-senha ----------
app.post('/auth/trocar-senha', autenticar, async (req, res) => {
  try {
    const erro = obrigatorios(req.body, ['senha_atual', 'senha_nova']);
    if (erro) return res.status(400).json({ erro });
    if (String(req.body.senha_nova).length < 8) {
      return res.status(400).json({ erro: 'A nova senha deve ter ao menos 8 caracteres.' });
    }
    const r = await pool.query(`SELECT senha_hash FROM usuarios WHERE id = $1`, [req.usuario.id]);
    const ok = await bcrypt.compare(req.body.senha_atual, r.rows[0].senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Senha atual incorreta.' });
    const hash = await bcrypt.hash(req.body.senha_nova, 10);
    await pool.query(`UPDATE usuarios SET senha_hash = $1, senha_provisoria = FALSE WHERE id = $2`, [hash, req.usuario.id]);
    res.json({ mensagem: 'Senha alterada com sucesso.' });
  } catch (e) {
    console.error('Erro /auth/trocar-senha:', e);
    res.status(500).json({ erro: 'Erro interno ao trocar senha.' });
  }
});

// ============================================================
// 3. CONFIGURAÇÕES
// ============================================================
app.get('/admin/configuracoes', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(`SELECT chave, valor, descricao, atualizado_em FROM configuracoes ORDER BY chave`);
    res.json(r.rows);
  } catch (e) {
    console.error('Erro GET configuracoes:', e);
    res.status(500).json({ erro: 'Erro ao listar configurações.' });
  }
});

app.put('/admin/configuracoes/:chave', autenticar, exigirPerfil('master'), async (req, res) => {
  try {
    if (req.body.valor === undefined) return res.status(400).json({ erro: 'Campo "valor" é obrigatório.' });
    const r = await pool.query(
      `UPDATE configuracoes SET valor = $1, atualizado_em = NOW(), atualizado_por = $2 WHERE chave = $3 RETURNING chave, valor`,
      [JSON.stringify(req.body.valor), req.usuario.id, req.params.chave]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Configuração não encontrada.' });
    res.json({ mensagem: 'Configuração atualizada.', configuracao: r.rows[0] });
  } catch (e) {
    console.error('Erro PUT configuracoes:', e);
    res.status(500).json({ erro: 'Erro ao atualizar configuração.' });
  }
});

async function marcarAtrasados() {
  await pool.query(`UPDATE contas_receber SET status='atrasada' WHERE status='pendente' AND vencimento < CURRENT_DATE`);
  await pool.query(`UPDATE contas_pagar SET status='atrasada' WHERE status='pendente' AND vencimento < CURRENT_DATE`);
}

async function getConfig(chave, padrao = null) {
  const r = await pool.query(`SELECT valor FROM configuracoes WHERE chave = $1`, [chave]);
  return r.rows.length ? r.rows[0].valor : padrao;
}

// ============================================================
// 4. CRUD — ALUNOS
// ============================================================
app.get('/admin/alunos', autenticar, somenteGestao, async (req, res) => {
  try {
    const { busca, status, modalidade } = req.query;
    const cond = [];
    const params = [];
    if (busca) { params.push(`%${busca}%`); cond.push(`(a.nome ILIKE $${params.length} OR a.cpf ILIKE $${params.length})`); }
    if (status) { params.push(status); cond.push(`a.status = $${params.length}`); }
    if (modalidade) { params.push(modalidade); cond.push(`a.modalidade = $${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const r = await pool.query(`SELECT a.* FROM alunos a ${where} ORDER BY a.nome`, params);
    res.json(r.rows);
  } catch (e) {
    console.error('Erro GET alunos:', e);
    res.status(500).json({ erro: 'Erro ao listar alunos.' });
  }
});

app.get('/admin/alunos/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const a = await pool.query(`SELECT * FROM alunos WHERE id = $1`, [req.params.id]);
    if (!a.rows.length) return res.status(404).json({ erro: 'Aluno não encontrado.' });
    const resp = await pool.query(
      `SELECT ar.id AS vinculo_id, r.id, r.nome, r.cpf, r.whatsapp, r.email, ar.parentesco, ar.responsavel_financeiro
       FROM aluno_responsavel ar JOIN responsaveis r ON r.id = ar.responsavel_id
       WHERE ar.aluno_id = $1`, [req.params.id]
    );
    res.json({ ...a.rows[0], responsaveis: resp.rows });
  } catch (e) {
    console.error('Erro GET aluno:', e);
    res.status(500).json({ erro: 'Erro ao buscar aluno.' });
  }
});

app.post('/admin/alunos', autenticar, somenteGestao, async (req, res) => {
  try {
    const erro = obrigatorios(req.body, ['nome', 'modalidade']);
    if (erro) return res.status(400).json({ erro });
    const { nome, data_nascimento, email, whatsapp, modalidade, observacoes } = req.body;
    const cpf = req.body.cpf ? soDigitos(req.body.cpf) : null;
    if (cpf && !cpfValido(cpf)) return res.status(400).json({ erro: 'CPF do aluno inválido — confira os dígitos.' });

    // Desconto fixo em R$ na mensalidade (apenas Pagante Parcial; bolsista é isento; taxa de matrícula nunca tem desconto)
    let desconto = Number(req.body.desconto_valor || 0);
    if (modalidade !== 'pagante_parcial' || isNaN(desconto) || desconto < 0) desconto = 0;

    const r = await pool.query(
      `INSERT INTO alunos (nome, data_nascimento, email, cpf, whatsapp, modalidade, desconto_valor, observacoes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [nome, data_nascimento || null, email || null, cpf, whatsapp || null, modalidade, desconto, observacoes || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Já existe aluno com este CPF.' });
    console.error('Erro POST aluno:', e);
    res.status(500).json({ erro: 'Erro ao cadastrar aluno.' });
  }
});

app.put('/admin/alunos/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const atual = await pool.query(`SELECT * FROM alunos WHERE id = $1`, [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Aluno não encontrado.' });
    const a = atual.rows[0];
    const modalidade = req.body.modalidade || a.modalidade;
    let desconto = req.body.desconto_valor !== undefined ? Number(req.body.desconto_valor) : Number(a.desconto_valor || 0);
    if (modalidade !== 'pagante_parcial' || isNaN(desconto) || desconto < 0) desconto = 0;
    if (req.body.cpf !== undefined && soDigitos(req.body.cpf) && !cpfValido(soDigitos(req.body.cpf))) {
      return res.status(400).json({ erro: 'CPF do aluno inválido — confira os dígitos.' });
    }
    const r = await pool.query(
      `UPDATE alunos SET nome=$1, data_nascimento=$2, email=$3, cpf=$4, whatsapp=$5, status=$6, modalidade=$7, desconto_valor=$8, observacoes=$9
       WHERE id=$10 RETURNING *`,
      [
        req.body.nome ?? a.nome,
        req.body.data_nascimento ?? a.data_nascimento,
        req.body.email ?? a.email,
        req.body.cpf !== undefined ? soDigitos(req.body.cpf) : a.cpf,
        req.body.whatsapp ?? a.whatsapp,
        req.body.status ?? a.status,
        modalidade, desconto,
        req.body.observacoes ?? a.observacoes,
        req.params.id
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Já existe aluno com este CPF.' });
    console.error('Erro PUT aluno:', e);
    res.status(500).json({ erro: 'Erro ao atualizar aluno.' });
  }
});

app.delete('/admin/alunos/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const m = await pool.query(`SELECT COUNT(*)::int AS n FROM matriculas WHERE aluno_id = $1`, [req.params.id]);
    if (m.rows[0].n > 0) {
      return res.status(409).json({ erro: 'Aluno possui matrículas registradas. Para preservar o histórico, altere o status para "inativo" em vez de excluir.' });
    }
    const r = await pool.query(`DELETE FROM alunos WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Aluno não encontrado.' });
    res.json({ mensagem: 'Aluno excluído.' });
  } catch (e) {
    console.error('Erro DELETE aluno:', e);
    res.status(500).json({ erro: 'Erro ao excluir aluno.' });
  }
});

// ---------- Vínculo aluno ↔ responsável ----------
app.post('/admin/alunos/:id/responsaveis', autenticar, somenteGestao, async (req, res) => {
  try {
    // Aceita responsavel_id (vínculo direto) OU dados do responsável (nome + cpf),
    // com upsert por CPF: se já existe, atualiza contato e apenas vincula.
    let respId = req.body.responsavel_id || null;
    if (!respId) {
      const erro = obrigatorios(req.body, ['nome', 'cpf']);
      if (erro) return res.status(400).json({ erro });
      const cpf = soDigitos(req.body.cpf);
      if (!cpfValido(cpf)) return res.status(400).json({ erro: 'CPF do responsável inválido — confira os dígitos.' });
      const existe = await pool.query(`SELECT id FROM responsaveis WHERE cpf = $1`, [cpf]);
      if (existe.rows.length) {
        respId = existe.rows[0].id;
        await pool.query(
          `UPDATE responsaveis SET nome=$1, email=COALESCE(NULLIF($2,''), email), whatsapp=COALESCE(NULLIF($3,''), whatsapp) WHERE id=$4`,
          [req.body.nome, req.body.email || '', req.body.whatsapp || '', respId]
        );
      } else {
        const novo = await pool.query(
          `INSERT INTO responsaveis (nome, cpf, email, whatsapp) VALUES ($1,$2,$3,$4) RETURNING id`,
          [req.body.nome, cpf, req.body.email || null, req.body.whatsapp || null]
        );
        respId = novo.rows[0].id;
      }
    }
    const r = await pool.query(
      `INSERT INTO aluno_responsavel (aluno_id, responsavel_id, parentesco, responsavel_financeiro)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, respId, req.body.parentesco || null, !!req.body.responsavel_financeiro]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Este responsável já está vinculado ao aluno.' });
    if (e.code === '23503') return res.status(400).json({ erro: 'Aluno ou responsável inexistente.' });
    console.error('Erro vínculo responsável:', e);
    res.status(500).json({ erro: 'Erro ao vincular responsável.' });
  }
});

app.delete('/admin/alunos/:id/responsaveis/:vinculoId', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM aluno_responsavel WHERE id = $1 AND aluno_id = $2 RETURNING id`,
      [req.params.vinculoId, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Vínculo não encontrado.' });
    res.json({ mensagem: 'Vínculo removido.' });
  } catch (e) {
    console.error('Erro remover vínculo:', e);
    res.status(500).json({ erro: 'Erro ao remover vínculo.' });
  }
});

// ============================================================
// 5. CRUD — RESPONSÁVEIS
// ============================================================
app.get('/admin/responsaveis', autenticar, somenteGestao, async (req, res) => {
  try {
    const { busca } = req.query;
    const params = [];
    let where = '';
    if (busca) { params.push(`%${busca}%`); where = `WHERE nome ILIKE $1 OR cpf ILIKE $1`; }
    const r = await pool.query(`SELECT * FROM responsaveis ${where} ORDER BY nome`, params);
    res.json(r.rows);
  } catch (e) {
    console.error('Erro GET responsaveis:', e);
    res.status(500).json({ erro: 'Erro ao listar responsáveis.' });
  }
});

app.post('/admin/responsaveis', autenticar, somenteGestao, async (req, res) => {
  try {
    const erro = obrigatorios(req.body, ['nome', 'cpf']);
    if (erro) return res.status(400).json({ erro });
    if (!cpfValido(soDigitos(req.body.cpf))) return res.status(400).json({ erro: 'CPF do responsável inválido — confira os dígitos.' });
    const r = await pool.query(
      `INSERT INTO responsaveis (nome, cpf, email, whatsapp) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.body.nome, soDigitos(req.body.cpf), req.body.email || null, req.body.whatsapp || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Já existe responsável com este CPF.' });
    console.error('Erro POST responsavel:', e);
    res.status(500).json({ erro: 'Erro ao cadastrar responsável.' });
  }
});

app.put('/admin/responsaveis/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const atual = await pool.query(`SELECT * FROM responsaveis WHERE id = $1`, [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Responsável não encontrado.' });
    const x = atual.rows[0];
    const r = await pool.query(
      `UPDATE responsaveis SET nome=$1, cpf=$2, email=$3, whatsapp=$4 WHERE id=$5 RETURNING *`,
      [
        req.body.nome ?? x.nome,
        req.body.cpf !== undefined ? soDigitos(req.body.cpf) : x.cpf,
        req.body.email ?? x.email,
        req.body.whatsapp ?? x.whatsapp,
        req.params.id
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Já existe responsável com este CPF.' });
    console.error('Erro PUT responsavel:', e);
    res.status(500).json({ erro: 'Erro ao atualizar responsável.' });
  }
});

app.delete('/admin/responsaveis/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM responsaveis WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Responsável não encontrado.' });
    res.json({ mensagem: 'Responsável excluído (vínculos com alunos removidos automaticamente).' });
  } catch (e) {
    console.error('Erro DELETE responsavel:', e);
    res.status(500).json({ erro: 'Erro ao excluir responsável.' });
  }
});

// ============================================================
// 6. CRUD — PROFESSORES
// ============================================================
app.get('/admin/professores', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM professores ORDER BY nome`);
    res.json(r.rows);
  } catch (e) {
    console.error('Erro GET professores:', e);
    res.status(500).json({ erro: 'Erro ao listar professores.' });
  }
});

app.post('/admin/professores', autenticar, somenteGestao, async (req, res) => {
  try {
    const erro = obrigatorios(req.body, ['nome']);
    if (erro) return res.status(400).json({ erro });
    const r = await pool.query(
      `INSERT INTO professores (nome, email, formacao, whatsapp, data_nascimento) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.body.nome, req.body.email || null, req.body.formacao || null, req.body.whatsapp || null, req.body.data_nascimento || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('Erro POST professor:', e);
    res.status(500).json({ erro: 'Erro ao cadastrar professor.' });
  }
});

app.put('/admin/professores/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const atual = await pool.query(`SELECT * FROM professores WHERE id = $1`, [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Professor não encontrado.' });
    const x = atual.rows[0];
    const r = await pool.query(
      `UPDATE professores SET nome=$1, email=$2, formacao=$3, whatsapp=$4, data_nascimento=$5, status=$6 WHERE id=$7 RETURNING *`,
      [
        req.body.nome ?? x.nome, req.body.email ?? x.email, req.body.formacao ?? x.formacao,
        req.body.whatsapp ?? x.whatsapp, req.body.data_nascimento ?? x.data_nascimento,
        req.body.status ?? x.status, req.params.id
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Erro PUT professor:', e);
    res.status(500).json({ erro: 'Erro ao atualizar professor.' });
  }
});

app.delete('/admin/professores/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const t = await pool.query(`SELECT COUNT(*)::int AS n FROM turmas WHERE professor_id = $1`, [req.params.id]);
    if (t.rows[0].n > 0) {
      return res.status(409).json({ erro: 'Professor vinculado a turmas. Altere o status para "inativo" ou troque o professor das turmas antes de excluir.' });
    }
    const r = await pool.query(`DELETE FROM professores WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Professor não encontrado.' });
    res.json({ mensagem: 'Professor excluído.' });
  } catch (e) {
    console.error('Erro DELETE professor:', e);
    res.status(500).json({ erro: 'Erro ao excluir professor.' });
  }
});

// ============================================================
// 7. CRUD — CURSOS E NÍVEIS
// ============================================================
app.get('/admin/cursos', autenticar, somenteGestao, async (req, res) => {
  try {
    const cursos = await pool.query(`SELECT * FROM cursos ORDER BY nome`);
    const niveis = await pool.query(`SELECT * FROM niveis ORDER BY curso_id, ordem`);
    res.json(cursos.rows.map(c => ({ ...c, niveis: niveis.rows.filter(n => n.curso_id === c.id) })));
  } catch (e) {
    console.error('Erro GET cursos:', e);
    res.status(500).json({ erro: 'Erro ao listar cursos.' });
  }
});

app.post('/admin/cursos', autenticar, somenteGestao, async (req, res) => {
  try {
    const erro = obrigatorios(req.body, ['nome']);
    if (erro) return res.status(400).json({ erro });
    const r = await pool.query(`INSERT INTO cursos (nome) VALUES ($1) RETURNING *`, [req.body.nome]);
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Já existe curso com este nome.' });
    console.error('Erro POST curso:', e);
    res.status(500).json({ erro: 'Erro ao cadastrar curso.' });
  }
});

app.post('/admin/niveis', autenticar, somenteGestao, async (req, res) => {
  try {
    const erro = obrigatorios(req.body, ['curso_id', 'nome', 'ordem']);
    if (erro) return res.status(400).json({ erro });
    const r = await pool.query(
      `INSERT INTO niveis (curso_id, nome, ordem, carga_horaria) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.body.curso_id, req.body.nome, req.body.ordem, req.body.carga_horaria || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Já existe nível com este nome neste curso.' });
    if (e.code === '23503') return res.status(400).json({ erro: 'Curso inexistente.' });
    console.error('Erro POST nivel:', e);
    res.status(500).json({ erro: 'Erro ao cadastrar nível.' });
  }
});

app.put('/admin/niveis/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const atual = await pool.query(`SELECT * FROM niveis WHERE id = $1`, [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Nível não encontrado.' });
    const x = atual.rows[0];
    const r = await pool.query(
      `UPDATE niveis SET nome=$1, ordem=$2, carga_horaria=$3 WHERE id=$4 RETURNING *`,
      [req.body.nome ?? x.nome, req.body.ordem ?? x.ordem, req.body.carga_horaria ?? x.carga_horaria, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Erro PUT nivel:', e);
    res.status(500).json({ erro: 'Erro ao atualizar nível.' });
  }
});

app.delete('/admin/niveis/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const t = await pool.query(`SELECT COUNT(*)::int AS n FROM turmas WHERE nivel_id = $1`, [req.params.id]);
    if (t.rows[0].n > 0) return res.status(409).json({ erro: 'Nível vinculado a turmas existentes. Exclusão bloqueada para preservar o histórico.' });
    const r = await pool.query(`DELETE FROM niveis WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Nível não encontrado.' });
    res.json({ mensagem: 'Nível excluído.' });
  } catch (e) {
    console.error('Erro DELETE nivel:', e);
    res.status(500).json({ erro: 'Erro ao excluir nível.' });
  }
});

// ============================================================
// 8. CRUD — TURMAS
// ============================================================
app.get('/admin/turmas', autenticar, somenteGestao, async (req, res) => {
  try {
    const { semestre, status } = req.query;
    const cond = []; const params = [];
    if (semestre) { params.push(semestre); cond.push(`t.semestre = $${params.length}`); }
    if (status) { params.push(status); cond.push(`t.status = $${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT t.*, n.nome AS nivel_nome, c.nome AS curso_nome, p.nome AS professor_nome,
              (SELECT COUNT(*)::int FROM matriculas m WHERE m.turma_id = t.id AND m.status = 'ativa') AS matriculados
       FROM turmas t
       JOIN niveis n ON n.id = t.nivel_id
       JOIN cursos c ON c.id = n.curso_id
       LEFT JOIN professores p ON p.id = t.professor_id
       ${where}
       ORDER BY t.semestre DESC, c.nome, n.ordem, t.nome`, params
    );
    res.json(r.rows);
  } catch (e) {
    console.error('Erro GET turmas:', e);
    res.status(500).json({ erro: 'Erro ao listar turmas.' });
  }
});

app.post('/admin/turmas', autenticar, somenteGestao, async (req, res) => {
  try {
    const erro = obrigatorios(req.body, ['nivel_id', 'nome', 'semestre']);
    if (erro) return res.status(400).json({ erro });
    let capacidade = req.body.capacidade;
    if (capacidade === undefined || capacidade === null || capacidade === '') {
      capacidade = (await getConfig('capacidade_padrao_turma', 15)) || 15;
    }
    const r = await pool.query(
      `INSERT INTO turmas (nivel_id, nome, semestre, turno, horario, professor_id, capacidade)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.body.nivel_id, req.body.nome, req.body.semestre, req.body.turno || null,
       req.body.horario || null, req.body.professor_id || null, Number(capacidade)]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Já existe turma com este nome neste semestre.' });
    if (e.code === '23503') return res.status(400).json({ erro: 'Nível ou professor inexistente.' });
    console.error('Erro POST turma:', e);
    res.status(500).json({ erro: 'Erro ao cadastrar turma.' });
  }
});

app.put('/admin/turmas/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const atual = await pool.query(`SELECT * FROM turmas WHERE id = $1`, [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Turma não encontrada.' });
    const x = atual.rows[0];
    const r = await pool.query(
      `UPDATE turmas SET nivel_id=$1, nome=$2, semestre=$3, turno=$4, horario=$5, professor_id=$6, capacidade=$7, status=$8
       WHERE id=$9 RETURNING *`,
      [
        req.body.nivel_id ?? x.nivel_id, req.body.nome ?? x.nome, req.body.semestre ?? x.semestre,
        req.body.turno ?? x.turno, req.body.horario ?? x.horario,
        req.body.professor_id !== undefined ? req.body.professor_id : x.professor_id,
        req.body.capacidade ?? x.capacidade, req.body.status ?? x.status, req.params.id
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Já existe turma com este nome neste semestre.' });
    console.error('Erro PUT turma:', e);
    res.status(500).json({ erro: 'Erro ao atualizar turma.' });
  }
});

app.delete('/admin/turmas/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const m = await pool.query(`SELECT COUNT(*)::int AS n FROM matriculas WHERE turma_id = $1`, [req.params.id]);
    if (m.rows[0].n > 0) return res.status(409).json({ erro: 'Turma possui matrículas. Altere o status para "encerrada" em vez de excluir.' });
    const r = await pool.query(`DELETE FROM turmas WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Turma não encontrada.' });
    res.json({ mensagem: 'Turma excluída.' });
  } catch (e) {
    console.error('Erro DELETE turma:', e);
    res.status(500).json({ erro: 'Erro ao excluir turma.' });
  }
});

// ============================================================
// 8B. MATRÍCULAS (Fase 2) — vaga validada, valores congelados,
//     mensalidades geradas automaticamente (R$ 0 para bolsistas)
// ============================================================
app.get('/admin/turmas/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const t = await pool.query(
      `SELECT t.*, n.nome AS nivel_nome, c.nome AS curso_nome, p.nome AS professor_nome
       FROM turmas t JOIN niveis n ON n.id = t.nivel_id JOIN cursos c ON c.id = n.curso_id
       LEFT JOIN professores p ON p.id = t.professor_id WHERE t.id = $1`, [req.params.id]);
    if (!t.rows.length) return res.status(404).json({ erro: 'Turma não encontrada.' });
    const m = await pool.query(
      `SELECT m.*, a.nome AS aluno_nome, a.modalidade
       FROM matriculas m JOIN alunos a ON a.id = m.aluno_id
       WHERE m.turma_id = $1 ORDER BY a.nome`, [req.params.id]);
    res.json({ ...t.rows[0], matriculas: m.rows });
  } catch (e) { console.error('Erro GET turma:', e); res.status(500).json({ erro: 'Erro ao buscar turma.' }); }
});

app.get('/admin/matriculas', autenticar, somenteGestao, async (req, res) => {
  try {
    const cond = []; const params = [];
    if (req.query.aluno_id) { params.push(req.query.aluno_id); cond.push(`m.aluno_id = $${params.length}`); }
    if (req.query.turma_id) { params.push(req.query.turma_id); cond.push(`m.turma_id = $${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT m.*, a.nome AS aluno_nome, t.nome AS turma_nome, t.semestre, t.turno, t.horario,
              n.nome AS nivel_nome, c.nome AS curso_nome
       FROM matriculas m
       JOIN alunos a ON a.id = m.aluno_id
       JOIN turmas t ON t.id = m.turma_id
       JOIN niveis n ON n.id = t.nivel_id
       JOIN cursos c ON c.id = n.curso_id
       ${where} ORDER BY t.semestre DESC, a.nome`, params);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET matriculas:', e); res.status(500).json({ erro: 'Erro ao listar matrículas.' }); }
});

app.delete('/admin/contas-receber/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM contas_receber WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Parcela não encontrada.' });
    res.json({ mensagem: 'Parcela excluída.' });
  } catch (e) { console.error('Erro DELETE contas-receber:', e); res.status(500).json({ erro: 'Erro ao excluir a parcela.' }); }
});

app.post('/admin/turmas/:id/encerrar', autenticar, somenteGestao, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query(`UPDATE turmas SET status='encerrada' WHERE id = $1 RETURNING id, nome`, [req.params.id]);
    if (!t.rows.length) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ erro: 'Turma não encontrada.' }); }
    const m = await client.query(`UPDATE matriculas SET status='concluida' WHERE turma_id = $1 AND status = 'ativa' RETURNING id`, [req.params.id]);
    await client.query('COMMIT'); client.release();
    res.json({ mensagem: 'Turma encerrada.', matriculas_concluidas: m.rows.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    console.error('Erro encerrar turma:', e);
    res.status(500).json({ erro: 'Erro ao encerrar a turma.' });
  }
});

app.post('/admin/matriculas', autenticar, somenteGestao, async (req, res) => {
  const client = await pool.connect();
  try {
    const erro = obrigatorios(req.body, ['aluno_id', 'turma_id']);
    if (erro) { client.release(); return res.status(400).json({ erro }); }

    await client.query('BEGIN');
    const tq = await client.query(
      `SELECT t.*, n.nome AS nivel_nome, c.nome AS curso_nome
       FROM turmas t JOIN niveis n ON n.id = t.nivel_id JOIN cursos c ON c.id = n.curso_id
       WHERE t.id = $1 FOR UPDATE OF t`, [req.body.turma_id]);
    if (!tq.rows.length) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ erro: 'Turma não encontrada.' }); }
    const turma = tq.rows[0];
    if (turma.status === 'encerrada') { await client.query('ROLLBACK'); client.release(); return res.status(409).json({ erro: 'Turma encerrada não recebe matrículas.' }); }

    const aq = await client.query(`SELECT * FROM alunos WHERE id = $1`, [req.body.aluno_id]);
    if (!aq.rows.length) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ erro: 'Aluno não encontrado.' }); }
    const aluno = aq.rows[0];
    if (aluno.status !== 'ativo') { await client.query('ROLLBACK'); client.release(); return res.status(409).json({ erro: 'Aluno inativo não pode ser matriculado. Reative o cadastro primeiro.' }); }

    const ocup = await client.query(`SELECT COUNT(*)::int AS n FROM matriculas WHERE turma_id = $1 AND status = 'ativa'`, [turma.id]);
    if (ocup.rows[0].n >= turma.capacidade) {
      await client.query('ROLLBACK'); client.release();
      return res.status(409).json({ erro: `Turma lotada — capacidade de ${turma.capacidade} alunos atingida.` });
    }

    const bolsista = aluno.modalidade === 'bolsista';
    const hoje = new Date();
    const diaVenc = Math.min(Number(await getConfig('dia_vencimento', 10)) || 10, 28);

    // Esquema de lançamento financeiro escolhido no ato:
    // '1' = 1º semestre (fev–jun) · '2' = 2º semestre (ago–dez) · 'sem' = sem financeiro (bolsista)
    let semLanc = String(req.body.semestre_lancamento || '').trim();
    if (!['1', '2', 'sem'].includes(semLanc)) {
      semLanc = bolsista ? 'sem' : (String(turma.semestre || '').endsWith('.1') ? '1' : '2');
    }
    const anoBase = parseInt(String(turma.semestre || '').split('.')[0], 10) || hoje.getFullYear();
    const mesesSem = semLanc === '1' ? [1, 2, 3, 4, 5] : semLanc === '2' ? [7, 8, 9, 10, 11] : [];

    // Valor da mensalidade (necessário apenas quando há lançamento de parcelas)
    const tabela = (await getConfig('mensalidades', {})) || {};
    const valor = Number(tabela[turma.curso_nome] || 0);
    if (mesesSem.length && !valor) {
      await client.query('ROLLBACK'); client.release();
      return res.status(400).json({ erro: `Defina o valor da mensalidade do curso ${turma.curso_nome} em Configurações antes de matricular.` });
    }
    const descontoAluno = Number(aluno.desconto_valor || 0);
    const vDesc = bolsista ? valor : +Math.min(descontoAluno, valor).toFixed(2);
    const vFinal = +(valor - vDesc).toFixed(2);

    // Taxa de matrícula: geral, paga sempre no ato (bolsista também paga)
    const taxa = req.body.taxa_matricula !== undefined
      ? Number(req.body.taxa_matricula) || 0
      : Number(await getConfig('taxa_matricula', 0)) || 0;
    const formaTaxa = String(req.body.forma_pagamento_taxa || '').trim();
    if (taxa > 0 && !formaTaxa) {
      await client.query('ROLLBACK'); client.release();
      return res.status(400).json({ erro: 'A taxa de matrícula é paga no ato — informe a forma de pagamento.' });
    }

    const mIns = await client.query(
      `INSERT INTO matriculas (aluno_id, turma_id, valor_mensalidade, desconto_aplicado)
       VALUES ($1,$2,$3,$4) RETURNING *`, [aluno.id, turma.id, valor, vDesc]);
    const matricula = mIns.rows[0];

    // Mensalidades do semestre escolhido (5 parcelas; bolsista usa "sem financeiro")
    for (const mes of mesesSem) {
      const venc = new Date(anoBase, mes, diaVenc);
      const comp = `${anoBase}-${String(mes + 1).padStart(2, '0')}`;
      await client.query(
        `INSERT INTO contas_receber
           (aluno_id, matricula_id, descricao, competencia, valor_original, desconto, valor_final,
            vencimento, status, data_pagamento, forma_pagamento, recebido_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [aluno.id, matricula.id,
         `Mensalidade ${String(mes + 1).padStart(2, '0')}/${anoBase} — ${turma.curso_nome} ${turma.nivel_nome}`,
         comp, valor, vDesc, vFinal, venc,
         bolsista ? 'paga' : 'pendente',
         bolsista ? hoje : null,
         bolsista ? 'Bolsa integral' : null,
         bolsista ? req.usuario.id : null]);
    }
    const parcelas = mesesSem.length;

    // Taxa da Plataforma Acadêmica (campo separado): 01/02, 01/08 ou bolsista (não lançar)
    let plataformaLancada = false;
    let platMes = String(req.body.plataforma_mes || '').trim(); // '2' | '8' | 'sem'
    if (!['2', '8', 'sem'].includes(platMes)) {
      const querPlat = req.body.plataforma === true || req.body.plataforma === 'true';
      platMes = querPlat && semLanc !== 'sem' ? (semLanc === '1' ? '2' : '8') : 'sem';
    }
    if (platMes === '2' || platMes === '8') {
      const valorPlat = Number(req.body.valor_plataforma) || Number(await getConfig('valor_plataforma', 25)) || 25;
      const mesPlat = platMes === '2' ? 1 : 7;
      const vencPlat = new Date(anoBase, mesPlat, 1);
      const compPlat = `${anoBase}-${String(mesPlat + 1).padStart(2, '0')}`;
      await client.query(
        `INSERT INTO contas_receber
           (aluno_id, matricula_id, descricao, competencia, valor_original, desconto, valor_final,
            vencimento, status, data_pagamento, forma_pagamento, recebido_por)
         VALUES ($1,$2,$3,$4,$5,0,$5,$6,'pendente',NULL,NULL,NULL)`,
        [aluno.id, matricula.id,
         `Taxa da Plataforma Acadêmica — ${turma.curso_nome} ${turma.nivel_nome}`,
         compPlat, valorPlat, vencPlat]);
      plataformaLancada = true;
    }

    // Lançamento da taxa (já quitada) + dados do recibo automático
    let recibo = null;
    if (taxa > 0) {
      const comp0 = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`;
      const tIns = await client.query(
        `INSERT INTO contas_receber
           (aluno_id, matricula_id, descricao, competencia, valor_original, desconto, valor_final,
            vencimento, status, data_pagamento, forma_pagamento, recebido_por)
         VALUES ($1,$2,$3,$4,$5,0,$5,$6,'paga',$6,$7,$8) RETURNING id`,
        [aluno.id, matricula.id,
         `Taxa de Matrícula — ${turma.curso_nome} ${turma.nivel_nome} (${turma.nome})`,
         comp0, taxa, hoje, formaTaxa, req.usuario.id]);
      recibo = {
        numero: tIns.rows[0].id, aluno_nome: aluno.nome,
        curso: turma.curso_nome, nivel: turma.nivel_nome, turma: turma.nome,
        turno: turma.turno, horario: turma.horario, semestre: turma.semestre,
        valor: taxa, forma: formaTaxa, data: hoje
      };
    }
    await client.query('COMMIT'); client.release();
    res.status(201).json({ matricula, mensalidades_geradas: parcelas, plataforma_lancada: plataformaLancada, bolsista, recibo });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    client.release();
    if (e.code === '23505') return res.status(409).json({ erro: 'Este aluno já está matriculado nesta turma.' });
    console.error('Erro POST matricula:', e);
    res.status(500).json({ erro: 'Erro ao efetivar matrícula.' });
  }
});

app.put('/admin/matriculas/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const novo = req.body.status;
    if (!['ativa', 'trancada', 'cancelada'].includes(novo)) return res.status(400).json({ erro: 'Status inválido.' });
    const r = await pool.query(
      `UPDATE matriculas SET status = $1 WHERE id = $2 AND status <> 'concluida' RETURNING *`,
      [novo, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Matrícula não encontrada (ou já concluída).' });
    if (novo === 'cancelada' || novo === 'trancada') {
      await pool.query(`UPDATE contas_receber SET status = 'cancelada' WHERE matricula_id = $1 AND status = 'pendente'`, [req.params.id]);
    }
    res.json({ mensagem: 'Matrícula atualizada.', matricula: r.rows[0] });
  } catch (e) { console.error('Erro PUT matricula:', e); res.status(500).json({ erro: 'Erro ao atualizar matrícula.' }); }
});

// ============================================================
// 8C. CONTAS A RECEBER — extrato e baixa com pontualidade (Fase 3)
// ============================================================
app.get('/admin/contas-receber', autenticar, somenteGestao, async (req, res) => {
  try {
    await marcarAtrasados();
    const cond = []; const params = [];
    if (req.query.aluno_id) { params.push(req.query.aluno_id); cond.push(`cr.aluno_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); cond.push(`cr.status = $${params.length}`); }
    if (req.query.competencia) { params.push(req.query.competencia); cond.push(`cr.competencia = $${params.length}`); }
    if (req.query.busca) {
      params.push(`%${req.query.busca}%`);
      cond.push(`(a.nome ILIKE $${params.length} OR cr.cliente_nome ILIKE $${params.length} OR cr.numero_documento ILIKE $${params.length} OR EXISTS (
        SELECT 1 FROM aluno_responsavel arb JOIN responsaveis rb ON rb.id = arb.responsavel_id
        WHERE arb.aluno_id = cr.aluno_id AND rb.nome ILIKE $${params.length}))`);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT cr.*, COALESCE(a.nome, cr.cliente_nome) AS aluno_nome, t.nome AS turma_nome, t.turno, t.horario, t.semestre,
              n.nome AS nivel_nome, c.nome AS curso_nome, pgt.nome AS pagante_nome
       FROM contas_receber cr
       LEFT JOIN alunos a ON a.id = cr.aluno_id
       LEFT JOIN matriculas m ON m.id = cr.matricula_id
       LEFT JOIN turmas t ON t.id = m.turma_id
       LEFT JOIN niveis n ON n.id = t.nivel_id
       LEFT JOIN cursos c ON c.id = n.curso_id
       LEFT JOIN LATERAL (
         SELECT r2.nome FROM aluno_responsavel ar2
         JOIN responsaveis r2 ON r2.id = ar2.responsavel_id
         WHERE ar2.aluno_id = cr.aluno_id AND ar2.responsavel_financeiro = TRUE
         ORDER BY ar2.id LIMIT 1
       ) pgt ON TRUE
       ${where} ORDER BY cr.vencimento, cr.id`, params);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET contas-receber:', e); res.status(500).json({ erro: 'Erro ao listar cobranças.' }); }
});

app.post('/admin/contas-receber', autenticar, somenteGestao, async (req, res) => {
  try {
    const descricao = String(req.body.descricao || '').trim();
    const valor = Number(req.body.valor || 0);
    const vencimento = String(req.body.vencimento || '').trim();
    if (!descricao) return res.status(400).json({ erro: 'Informe a descrição da cobrança.' });
    if (!(valor > 0)) return res.status(400).json({ erro: 'Informe um valor maior que zero.' });
    if (!vencimento) return res.status(400).json({ erro: 'Informe o vencimento.' });
    const alunoId = req.body.aluno_id ? Number(req.body.aluno_id) : null;
    const clienteNome = String(req.body.cliente_nome || '').trim() || null;
    if (!alunoId && !clienteNome) return res.status(400).json({ erro: 'Informe um aluno ou o nome do cliente.' });
    const competencia = String(req.body.competencia || '').trim() || vencimento.slice(0, 7);
    const r = await pool.query(
      `INSERT INTO contas_receber
         (aluno_id, matricula_id, descricao, competencia, valor_original, desconto, valor_final, vencimento, status, cliente_nome)
       VALUES ($1, NULL, $2, $3, $4, 0, $4, $5, 'pendente', $6) RETURNING *`,
      [alunoId, descricao, competencia, valor, vencimento, clienteNome]);
    res.status(201).json(r.rows[0]);
  } catch (e) { console.error('Erro POST conta avulsa:', e); res.status(500).json({ erro: 'Erro ao lançar a conta a receber.' }); }
});

app.post('/admin/contas-receber/:id/baixa', autenticar, somenteGestao, async (req, res) => {
  try {
    const forma = String(req.body.forma_pagamento || '').trim();
    if (!forma) return res.status(400).json({ erro: 'Informe a forma de pagamento.' });

    const cq = await pool.query(
      `SELECT cr.*, COALESCE(a.nome, cr.cliente_nome) AS aluno_nome, t.nome AS turma_nome, t.turno, t.horario, t.semestre,
              n.nome AS nivel_nome, c.nome AS curso_nome
       FROM contas_receber cr
       LEFT JOIN alunos a ON a.id = cr.aluno_id
       LEFT JOIN matriculas m ON m.id = cr.matricula_id
       LEFT JOIN turmas t ON t.id = m.turma_id
       LEFT JOIN niveis n ON n.id = t.nivel_id
       LEFT JOIN cursos c ON c.id = n.curso_id
       WHERE cr.id = $1`, [req.params.id]);
    if (!cq.rows.length) return res.status(404).json({ erro: 'Cobrança não encontrada.' });
    const conta = cq.rows[0];
    if (!['pendente', 'atrasada'].includes(conta.status)) {
      return res.status(409).json({ erro: `Esta cobrança já está ${conta.status}.` });
    }

    const dataPg = req.body.data_pagamento
      ? new Date(req.body.data_pagamento + 'T12:00:00') : new Date();
    const valorFinal = Number(conta.valor_final);

    // Desconto: usa o informado na baixa; se ausente, sugere a pontualidade (mensalidade paga até o vencimento)
    const ehMensalidade = String(conta.descricao || '').startsWith('Mensalidade');
    const pontual = dataPg.toISOString().slice(0, 10) <= new Date(conta.vencimento).toISOString().slice(0, 10);
    const descCfg = Number(await getConfig('desconto_pontualidade', 0)) || 0;
    const sugestao = (ehMensalidade && pontual) ? Math.min(descCfg, valorFinal) : 0;
    let desconto = req.body.desconto !== undefined ? Number(req.body.desconto) || 0 : sugestao;
    desconto = +Math.max(0, Math.min(desconto, valorFinal)).toFixed(2);
    const juros = +Math.max(0, Number(req.body.juros || 0)).toFixed(2);
    let valorRecebido = req.body.valor_recebido !== undefined
      ? Number(req.body.valor_recebido) || 0
      : +(valorFinal - desconto + juros).toFixed(2);
    valorRecebido = +Math.max(0, valorRecebido).toFixed(2);

    await pool.query(
      `UPDATE contas_receber SET status='paga', data_pagamento=$1, forma_pagamento=$2,
              desconto_pontualidade=$3, juros=$4, valor_recebido=$5, recebido_por=$6 WHERE id=$7`,
      [dataPg, forma, desconto, juros, valorRecebido, req.usuario.id, req.params.id]);

    res.json({
      mensagem: 'Pagamento registrado.',
      recibo: {
        numero: conta.numero_documento, aluno_nome: conta.aluno_nome,
        referente: conta.descricao + (conta.semestre ? ` · Semestre ${conta.semestre}` : ''),
        turma: conta.turma_nome, turno: conta.turno, horario: conta.horario,
        valor_base: valorFinal, desconto, juros, desconto_pontualidade: desconto,
        valor: valorRecebido, forma, data: dataPg
      }
    });
  } catch (e) { console.error('Erro baixa contas-receber:', e); res.status(500).json({ erro: 'Erro ao registrar o pagamento.' }); }
});

// ============================================================
// 9. CRUD — FORNECEDORES
// ============================================================
app.get('/admin/fornecedores', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM fornecedores ORDER BY nome`);
    res.json(r.rows);
  } catch (e) {
    console.error('Erro GET fornecedores:', e);
    res.status(500).json({ erro: 'Erro ao listar fornecedores.' });
  }
});

app.post('/admin/fornecedores', autenticar, somenteGestao, async (req, res) => {
  try {
    const erro = obrigatorios(req.body, ['nome']);
    if (erro) return res.status(400).json({ erro });
    const r = await pool.query(
      `INSERT INTO fornecedores (nome, cpf_cnpj, email, whatsapp, categoria, observacoes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.body.nome, req.body.cpf_cnpj || null, req.body.email || null,
       req.body.whatsapp || null, req.body.categoria || null, req.body.observacoes || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('Erro POST fornecedor:', e);
    res.status(500).json({ erro: 'Erro ao cadastrar fornecedor.' });
  }
});

app.put('/admin/fornecedores/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const atual = await pool.query(`SELECT * FROM fornecedores WHERE id = $1`, [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Fornecedor não encontrado.' });
    const x = atual.rows[0];
    const r = await pool.query(
      `UPDATE fornecedores SET nome=$1, cpf_cnpj=$2, email=$3, whatsapp=$4, categoria=$5, observacoes=$6, status=$7
       WHERE id=$8 RETURNING *`,
      [
        req.body.nome ?? x.nome, req.body.cpf_cnpj ?? x.cpf_cnpj, req.body.email ?? x.email,
        req.body.whatsapp ?? x.whatsapp, req.body.categoria ?? x.categoria,
        req.body.observacoes ?? x.observacoes, req.body.status ?? x.status, req.params.id
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('Erro PUT fornecedor:', e);
    res.status(500).json({ erro: 'Erro ao atualizar fornecedor.' });
  }
});

app.delete('/admin/fornecedores/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const c = await pool.query(`SELECT COUNT(*)::int AS n FROM contas_pagar WHERE fornecedor_id = $1`, [req.params.id]);
    if (c.rows[0].n > 0) return res.status(409).json({ erro: 'Fornecedor possui contas registradas. Altere o status para "inativo" em vez de excluir.' });
    const r = await pool.query(`DELETE FROM fornecedores WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Fornecedor não encontrado.' });
    res.json({ mensagem: 'Fornecedor excluído.' });
  } catch (e) {
    console.error('Erro DELETE fornecedor:', e);
    res.status(500).json({ erro: 'Erro ao excluir fornecedor.' });
  }
});

// ============================================================
// 9B. CONTAS A PAGAR (Fase 3) + marcação automática de atrasados
// ============================================================
app.get('/admin/contas-pagar', autenticar, somenteGestao, async (req, res) => {
  try {
    await marcarAtrasados();
    const cond = []; const params = [];
    if (req.query.status) { params.push(req.query.status); cond.push(`cp.status = $${params.length}`); }
    if (req.query.categoria) { params.push(req.query.categoria); cond.push(`cp.categoria = $${params.length}`); }
    if (req.query.busca) { params.push(`%${req.query.busca}%`); cond.push(`(cp.descricao ILIKE $${params.length} OR f.nome ILIKE $${params.length})`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT cp.*, f.nome AS fornecedor_nome
       FROM contas_pagar cp LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
       ${where} ORDER BY cp.vencimento, cp.id`, params);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET contas-pagar:', e); res.status(500).json({ erro: 'Erro ao listar contas a pagar.' }); }
});

app.post('/admin/contas-pagar', autenticar, somenteGestao, async (req, res) => {
  try {
    const erro = obrigatorios(req.body, ['descricao', 'valor', 'vencimento']);
    if (erro) return res.status(400).json({ erro });
    const r = await pool.query(
      `INSERT INTO contas_pagar (fornecedor_id, descricao, categoria, valor, vencimento, criado_por)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.body.fornecedor_id || null, req.body.descricao, req.body.categoria || null,
       Number(req.body.valor), req.body.vencimento, req.usuario.id]);
    res.status(201).json(r.rows[0]);
  } catch (e) { console.error('Erro POST contas-pagar:', e); res.status(500).json({ erro: 'Erro ao cadastrar conta a pagar.' }); }
});

app.put('/admin/contas-pagar/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const atual = await pool.query(`SELECT * FROM contas_pagar WHERE id = $1`, [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Conta não encontrada.' });
    const x = atual.rows[0];
    const r = await pool.query(
      `UPDATE contas_pagar SET fornecedor_id=$1, descricao=$2, categoria=$3, valor=$4, vencimento=$5 WHERE id=$6 RETURNING *`,
      [req.body.fornecedor_id !== undefined ? req.body.fornecedor_id : x.fornecedor_id,
       req.body.descricao ?? x.descricao, req.body.categoria ?? x.categoria,
       req.body.valor !== undefined ? Number(req.body.valor) : x.valor,
       req.body.vencimento ?? x.vencimento, req.params.id]);
    res.json(r.rows[0]);
  } catch (e) { console.error('Erro PUT contas-pagar:', e); res.status(500).json({ erro: 'Erro ao atualizar conta a pagar.' }); }
});

app.post('/admin/contas-pagar/:id/baixa', autenticar, somenteGestao, async (req, res) => {
  try {
    const forma = String(req.body.forma_pagamento || '').trim();
    if (!forma) return res.status(400).json({ erro: 'Informe a forma de pagamento.' });
    const dataPg = req.body.data_pagamento ? new Date(req.body.data_pagamento + 'T12:00:00') : new Date();
    const r = await pool.query(
      `UPDATE contas_pagar SET status='paga', data_pagamento=$1, forma_pagamento=$2 WHERE id=$3 AND status <> 'cancelada' RETURNING *`,
      [dataPg, forma, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Conta não encontrada (ou cancelada).' });
    res.json({ mensagem: 'Conta paga.', conta: r.rows[0] });
  } catch (e) { console.error('Erro baixa contas-pagar:', e); res.status(500).json({ erro: 'Erro ao pagar a conta.' }); }
});

app.delete('/admin/contas-pagar/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM contas_pagar WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Conta não encontrada.' });
    res.json({ mensagem: 'Conta a pagar excluída.' });
  } catch (e) { console.error('Erro DELETE contas-pagar:', e); res.status(500).json({ erro: 'Erro ao excluir conta a pagar.' }); }
});

// ============================================================
// 9C. RELATÓRIOS (Fase 5 — núcleo financeiro e de turmas)
// ============================================================
app.get('/admin/relatorios/financeiro', autenticar, somenteGestao, async (req, res) => {
  try {
    await marcarAtrasados();
    const hoje = new Date();
    const ini = req.query.inicio || `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;
    const fim = req.query.fim || hoje.toISOString().slice(0, 10);

    const recebido = await pool.query(
      `SELECT COALESCE(SUM(COALESCE(valor_recebido, valor_final - desconto_pontualidade)),0)::numeric AS total, COUNT(*)::int AS qtd
       FROM contas_receber WHERE status='paga' AND data_pagamento::date BETWEEN $1 AND $2`, [ini, fim]);
    const porForma = await pool.query(
      `SELECT forma_pagamento, COALESCE(SUM(COALESCE(valor_recebido, valor_final - desconto_pontualidade)),0)::numeric AS total, COUNT(*)::int AS qtd
       FROM contas_receber WHERE status='paga' AND data_pagamento::date BETWEEN $1 AND $2
       GROUP BY forma_pagamento ORDER BY total DESC`, [ini, fim]);
    const aberto = await pool.query(
      `SELECT COALESCE(SUM(valor_final),0)::numeric AS total, COUNT(*)::int AS qtd,
              COALESCE(SUM(valor_final) FILTER (WHERE status='atrasada'),0)::numeric AS total_atrasado,
              COUNT(*) FILTER (WHERE status='atrasada')::int AS qtd_atrasado
       FROM contas_receber WHERE status IN ('pendente','atrasada')`);
    const pontualidade = await pool.query(
      `SELECT COALESCE(SUM(desconto_pontualidade),0)::numeric AS total
       FROM contas_receber WHERE status='paga' AND data_pagamento::date BETWEEN $1 AND $2`, [ini, fim]);
    const bolsas = await pool.query(
      `SELECT COALESCE(SUM(valor_original),0)::numeric AS total, COUNT(*)::int AS qtd
       FROM contas_receber WHERE forma_pagamento='Bolsa integral' AND data_pagamento::date BETWEEN $1 AND $2`, [ini, fim]);
    const pago = await pool.query(
      `SELECT COALESCE(SUM(valor),0)::numeric AS total, COUNT(*)::int AS qtd
       FROM contas_pagar WHERE status='paga' AND data_pagamento::date BETWEEN $1 AND $2`, [ini, fim]);
    const aPagar = await pool.query(
      `SELECT COALESCE(SUM(valor),0)::numeric AS total, COUNT(*)::int AS qtd,
              COALESCE(SUM(valor) FILTER (WHERE status='atrasada'),0)::numeric AS total_atrasado
       FROM contas_pagar WHERE status IN ('pendente','atrasada')`);

    res.json({
      periodo: { inicio: ini, fim },
      recebido: recebido.rows[0], por_forma: porForma.rows, a_receber: aberto.rows[0],
      pontualidade_concedida: pontualidade.rows[0].total, bolsas: bolsas.rows[0],
      pago: pago.rows[0], a_pagar: aPagar.rows[0]
    });
  } catch (e) { console.error('Erro relatório financeiro:', e); res.status(500).json({ erro: 'Erro ao gerar relatório financeiro.' }); }
});

app.get('/admin/relatorios/turmas', autenticar, somenteGestao, async (req, res) => {
  try {
    const cond = []; const params = [];
    if (req.query.semestre) { params.push(req.query.semestre); cond.push(`t.semestre = $${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const r = await pool.query(
      `SELECT t.id, t.nome, t.semestre, t.turno, t.horario, t.capacidade, t.status,
              c.nome AS curso_nome, n.nome AS nivel_nome, p.nome AS professor_nome,
              (SELECT COUNT(*)::int FROM matriculas m WHERE m.turma_id=t.id AND m.status='ativa') AS matriculados,
              (SELECT COUNT(*)::int FROM matriculas m JOIN alunos a ON a.id=m.aluno_id WHERE m.turma_id=t.id AND m.status='ativa' AND a.modalidade='bolsista') AS bolsistas
       FROM turmas t JOIN niveis n ON n.id=t.nivel_id JOIN cursos c ON c.id=n.curso_id
       LEFT JOIN professores p ON p.id=t.professor_id
       ${where} ORDER BY t.semestre DESC, c.nome, n.ordem, t.nome`, params);
    res.json(r.rows);
  } catch (e) { console.error('Erro relatório turmas:', e); res.status(500).json({ erro: 'Erro ao gerar relatório de turmas.' });

app.get('/admin/relatorios/financeiro-detalhado', autenticar, somenteGestao, async (req, res) => {
  try {
    await marcarAtrasados();
    const hoje = new Date();
    const ini = req.query.inicio || `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;
    const fim = req.query.fim || hoje.toISOString().slice(0, 10);

    const SELECT = `
      SELECT cr.id, cr.descricao, cr.competencia, cr.vencimento, cr.valor_final, cr.desconto_pontualidade,
             cr.data_pagamento, cr.forma_pagamento, cr.status,
             COALESCE(a.nome, cr.cliente_nome) AS aluno_nome, pgt.nome AS pagante_nome,
             CASE WHEN cr.descricao LIKE 'Mensalidade%' THEN
               (SELECT COUNT(*) FROM contas_receber x WHERE x.matricula_id = cr.matricula_id
                 AND x.descricao LIKE 'Mensalidade%' AND x.vencimento <= cr.vencimento) END AS parcela_num,
             CASE WHEN cr.descricao LIKE 'Mensalidade%' THEN
               (SELECT COUNT(*) FROM contas_receber x WHERE x.matricula_id = cr.matricula_id
                 AND x.descricao LIKE 'Mensalidade%') END AS parcela_total
      FROM contas_receber cr
      LEFT JOIN alunos a ON a.id = cr.aluno_id
      LEFT JOIN LATERAL (
        SELECT r2.nome FROM aluno_responsavel ar2 JOIN responsaveis r2 ON r2.id = ar2.responsavel_id
        WHERE ar2.aluno_id = cr.aluno_id AND ar2.responsavel_financeiro = TRUE ORDER BY ar2.id LIMIT 1
      ) pgt ON TRUE `;

    const recebidas = await pool.query(
      `${SELECT} WHERE cr.status='paga' AND cr.data_pagamento::date BETWEEN $1 AND $2
       ORDER BY cr.data_pagamento, pgt.nome NULLS LAST, a.nome`, [ini, fim]);
    const aReceber = await pool.query(
      `${SELECT} WHERE cr.status='pendente' AND cr.vencimento BETWEEN $1 AND $2
       ORDER BY cr.vencimento, pgt.nome NULLS LAST, a.nome`, [ini, fim]);
    const vencidas = await pool.query(
      `${SELECT} WHERE cr.status='atrasada' AND cr.vencimento <= $1
       ORDER BY cr.vencimento, pgt.nome NULLS LAST, a.nome`, [fim]);

    const soma = (rows, campo) => rows.reduce((s, r) => s + Number(r[campo] || 0), 0);
    res.json({
      periodo: { inicio: ini, fim },
      recebidas: recebidas.rows, a_receber: aReceber.rows, vencidas: vencidas.rows,
      totais: {
        recebido: recebidas.rows.reduce((s, r) => s + (Number(r.valor_final) - Number(r.desconto_pontualidade || 0)), 0),
        a_receber: soma(aReceber.rows, 'valor_final'),
        vencido: soma(vencidas.rows, 'valor_final')
      }
    });
  } catch (e) { console.error('Erro relatório detalhado:', e); res.status(500).json({ erro: 'Erro ao gerar relatório detalhado.' }); }
}); }
});

// ============================================================
// 10. CRUD — USUÁRIOS (apenas master)
// ============================================================
app.get('/admin/usuarios', autenticar, exigirPerfil('master'), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, codigo, nome, cpf, email, whatsapp, data_nascimento, perfil, referencia_id, status, senha_provisoria, criado_em, ultimo_acesso
       FROM usuarios ORDER BY nome`
    );
    res.json(r.rows);
  } catch (e) {
    console.error('Erro GET usuarios:', e);
    res.status(500).json({ erro: 'Erro ao listar usuários.' });
  }
});

app.post('/admin/usuarios', autenticar, exigirPerfil('master'), async (req, res) => {
  try {
    const erro = obrigatorios(req.body, ['nome', 'cpf', 'senha', 'perfil']);
    if (erro) return res.status(400).json({ erro });
    if (String(req.body.senha).length < 8) return res.status(400).json({ erro: 'A senha deve ter ao menos 8 caracteres.' });
    if (!cpfValido(soDigitos(req.body.cpf))) return res.status(400).json({ erro: 'CPF do usuário inválido — confira os dígitos.' });
    const hash = await bcrypt.hash(req.body.senha, 10);
    const r = await pool.query(
      `INSERT INTO usuarios (nome, cpf, email, whatsapp, senha_hash, data_nascimento, perfil, referencia_id, senha_provisoria)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)
       RETURNING id, nome, cpf, perfil, referencia_id, status`,
      [req.body.nome, soDigitos(req.body.cpf), req.body.email || null, req.body.whatsapp || null,
       hash, req.body.data_nascimento || null, req.body.perfil, req.body.referencia_id || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Já existe usuário com este CPF.' });
    console.error('Erro POST usuario:', e);
    res.status(500).json({ erro: 'Erro ao cadastrar usuário.' });
  }
});

app.put('/admin/usuarios/:id', autenticar, exigirPerfil('master'), async (req, res) => {
  try {
    const atual = await pool.query(`SELECT * FROM usuarios WHERE id = $1`, [req.params.id]);
    if (!atual.rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const x = atual.rows[0];
    if (req.body.cpf !== undefined && !cpfValido(soDigitos(req.body.cpf))) {
      return res.status(400).json({ erro: 'CPF do usuário inválido — confira os dígitos.' });
    }

    // Proteção: não permitir inativar/rebaixar o último master ativo
    const novoPerfil = req.body.perfil ?? x.perfil;
    const novoStatus = req.body.status ?? x.status;
    if (x.perfil === 'master' && (novoPerfil !== 'master' || novoStatus !== 'ativo')) {
      const outros = await pool.query(`SELECT COUNT(*)::int AS n FROM usuarios WHERE perfil='master' AND status='ativo' AND id <> $1`, [x.id]);
      if (outros.rows[0].n === 0) return res.status(409).json({ erro: 'Não é possível inativar ou rebaixar o único usuário master ativo.' });
    }

    let senha_hash = x.senha_hash;
    let senha_provisoria = x.senha_provisoria;
    if (req.body.senha) {
      if (String(req.body.senha).length < 8) return res.status(400).json({ erro: 'A senha deve ter ao menos 8 caracteres.' });
      senha_hash = await bcrypt.hash(req.body.senha, 10);
      senha_provisoria = true;
    }
    const r = await pool.query(
      `UPDATE usuarios SET nome=$1, cpf=$2, email=$3, whatsapp=$4, data_nascimento=$5, perfil=$6, referencia_id=$7, status=$8, senha_hash=$9, senha_provisoria=$10
       WHERE id=$11 RETURNING id, nome, cpf, perfil, referencia_id, status`,
      [
        req.body.nome ?? x.nome,
        req.body.cpf !== undefined ? soDigitos(req.body.cpf) : x.cpf,
        req.body.email ?? x.email, req.body.whatsapp ?? x.whatsapp,
        req.body.data_nascimento ?? x.data_nascimento,
        novoPerfil, req.body.referencia_id ?? x.referencia_id, novoStatus,
        senha_hash, senha_provisoria, req.params.id
      ]
    );
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ erro: 'Já existe usuário com este CPF.' });
    console.error('Erro PUT usuario:', e);
    res.status(500).json({ erro: 'Erro ao atualizar usuário.' });
  }
});

app.delete('/admin/usuarios/:id', autenticar, exigirPerfil('master'), async (req, res) => {
  try {
    if (Number(req.params.id) === req.usuario.id) {
      return res.status(409).json({ erro: 'Você não pode excluir o próprio usuário em uso.' });
    }
    const alvo = await pool.query(`SELECT perfil, status FROM usuarios WHERE id = $1`, [req.params.id]);
    if (!alvo.rows.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (alvo.rows[0].perfil === 'master') {
      const outros = await pool.query(`SELECT COUNT(*)::int AS n FROM usuarios WHERE perfil='master' AND status='ativo' AND id <> $1`, [req.params.id]);
      if (outros.rows[0].n === 0) return res.status(409).json({ erro: 'Não é possível excluir o único usuário master ativo.' });
    }
    await pool.query(`DELETE FROM usuarios WHERE id = $1`, [req.params.id]);
    res.json({ mensagem: 'Usuário excluído.' });
  } catch (e) {
    console.error('Erro DELETE usuario:', e);
    res.status(500).json({ erro: 'Erro ao excluir usuário.' });
  }
});

// ============================================================
// 11. FRONTEND SERVIDO PELO BACKEND (pasta /public no repositório)
// ============================================================
const PASTA_PUBLIC = path.join(__dirname, 'public');
// ============================================================
// PORTAL DOS PAIS — PRÉ-INSCRIÇÃO ONLINE (públicas, sem autenticação)
// ============================================================
app.get('/publico/opcoes', limiterPublico, async (req, res) => {
  try {
    const taxa = Number(await getConfig('taxa_matricula', 0)) || 0;
    const semestre = String(await getConfig('semestre_vigente', '') || '');
    const t = await pool.query(
      `SELECT DISTINCT turno FROM turmas WHERE status <> 'encerrada' AND turno IS NOT NULL AND turno <> '' ORDER BY turno`);
    let turnos = t.rows.map(r => r.turno);
    if (!turnos.length) turnos = ['Matutino', 'Vespertino'];
    res.json({ taxa_matricula: taxa, semestre, turnos });
  } catch (e) { console.error('Erro /publico/opcoes:', e); res.status(500).json({ erro: 'Erro ao carregar as opções de inscrição.' }); }
});

app.post('/publico/pre-inscricao', limiterPublico, async (req, res) => {
  try {
    const alunoNome = String(req.body.aluno_nome || '').trim();
    const nasc = String(req.body.aluno_data_nascimento || '').trim();
    const turno = String(req.body.turno || '').trim();
    const respNome = String(req.body.responsavel_nome || '').trim();
    const respZap = String(req.body.responsavel_whatsapp || '').trim();
    const respEmail = String(req.body.responsavel_email || '').trim();
    const respCpf = String(req.body.responsavel_cpf || '').trim();
    const alunoCpf = String(req.body.aluno_cpf || '').trim();
    const parentesco = String(req.body.parentesco || '').trim();
    const aceite = req.body.aceite_termos === true || req.body.aceite_termos === 'true';

    if (!alunoNome) return res.status(400).json({ erro: 'Informe o nome do aluno.' });
    if (!nasc) return res.status(400).json({ erro: 'Informe a data de nascimento do aluno.' });
    if (!turno) return res.status(400).json({ erro: 'Escolha o turno.' });
    if (!respNome) return res.status(400).json({ erro: 'Informe o nome do responsável.' });
    if (!respZap && !respEmail) return res.status(400).json({ erro: 'Informe ao menos um contato (WhatsApp ou e-mail).' });
    if (!aceite) return res.status(400).json({ erro: 'É necessário aceitar os Termos e a Política de Privacidade.' });

    const dn = new Date(nasc + 'T12:00:00');
    if (isNaN(dn.getTime())) return res.status(400).json({ erro: 'Data de nascimento inválida.' });
    const hoje = new Date();
    let idade = hoje.getFullYear() - dn.getFullYear();
    const dm = hoje.getMonth() - dn.getMonth();
    if (dm < 0 || (dm === 0 && hoje.getDate() < dn.getDate())) idade--;
    if (idade < 0 || idade > 120) return res.status(400).json({ erro: 'Data de nascimento inválida.' });
    const programa = idade < 10 ? 'kids' : 'basico';

    const taxa = Number(await getConfig('taxa_matricula', 0)) || 0;

    const r = await pool.query(
      `INSERT INTO pre_inscricoes
         (aluno_nome, aluno_data_nascimento, aluno_cpf, programa, turno,
          responsavel_nome, responsavel_cpf, responsavel_whatsapp, responsavel_email, parentesco, valor_taxa)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [alunoNome.toUpperCase(), nasc, alunoCpf || null, programa, turno,
       respNome.toUpperCase(), respCpf || null, respZap || null, respEmail || null, parentesco || null, taxa]);
    const id = r.rows[0].id;
    const protocolo = `PRE-${hoje.getFullYear()}-${String(id).padStart(6, '0')}`;
    await pool.query(`UPDATE pre_inscricoes SET protocolo = $1 WHERE id = $2`, [protocolo, id]);

    res.status(201).json({
      id, protocolo, programa, programa_label: programa === 'kids' ? 'KIDS' : 'Básico',
      turno, idade, valor_taxa: taxa,
      mensagem: 'Pré-inscrição registrada. O pagamento da taxa via PIX será habilitado na próxima etapa.'
    });
  } catch (e) { console.error('Erro /publico/pre-inscricao:', e); res.status(500).json({ erro: 'Erro ao registrar a pré-inscrição.' }); }
});

app.get('/admin/pre-inscricoes', autenticar, somenteGestao, async (req, res) => {
  try {
    const cond = []; const params = [];
    if (req.query.status) { params.push(req.query.status); cond.push(`status = $${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM pre_inscricoes ${where} ORDER BY criado_em DESC`, params);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET pre-inscricoes:', e); res.status(500).json({ erro: 'Erro ao listar pré-inscrições.' }); }
});

// ============================================================
// INTEGRAÇÃO PIX — BANCO INTER (Portal dos Pais)
// ============================================================
const INTER = {
  base: process.env.INTER_BASE_URL || 'https://cdpj.partners.bancointer.com.br',
  clientId: process.env.INTER_CLIENT_ID || '',
  clientSecret: process.env.INTER_CLIENT_SECRET || '',
  cert: (process.env.INTER_CERT || '').replace(/\\n/g, '\n'),
  key: (process.env.INTER_KEY || '').replace(/\\n/g, '\n'),
  chave: process.env.INTER_PIX_KEY || '',
  conta: process.env.INTER_CONTA_CORRENTE || ''
};
const INTER_SCOPES = 'cob.write cob.read pix.read webhook.write webhook.read';
function interConfigurado() {
  return !!(INTER.clientId && INTER.clientSecret && INTER.cert && INTER.key && INTER.chave);
}
let interAgent = null;
function getInterAgent() {
  if (!interAgent) interAgent = new https.Agent({ cert: INTER.cert, key: INTER.key, keepAlive: true });
  return interAgent;
}
function interHttp(method, pathname, { token, body, form } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(INTER.base + pathname);
    const payload = form ? new URLSearchParams(form).toString() : (body ? JSON.stringify(body) : null);
    const headers = {};
    if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    else if (body) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (INTER.conta) headers['x-conta-corrente'] = INTER.conta;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const r = https.request({ hostname: url.hostname, path: url.pathname + url.search, method, headers, agent: getInterAgent() }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        let parsed; try { parsed = data ? JSON.parse(data) : {}; } catch { parsed = { raw: data }; }
        if (resp.statusCode >= 200 && resp.statusCode < 300) resolve(parsed);
        else reject(new Error(`Inter ${resp.statusCode}: ${JSON.stringify(parsed)}`));
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
let interTokenCache = { token: null, exp: 0 };
async function interToken() {
  const now = Date.now();
  if (interTokenCache.token && interTokenCache.exp > now + 30000) return interTokenCache.token;
  const r = await interHttp('POST', '/oauth/v2/token', { form: {
    client_id: INTER.clientId, client_secret: INTER.clientSecret,
    grant_type: 'client_credentials', scope: INTER_SCOPES
  }});
  interTokenCache = { token: r.access_token, exp: now + (Number(r.expires_in || 3600) * 1000) };
  return r.access_token;
}
async function interCriarCob(txid, valor, solicitacao) {
  const token = await interToken();
  return interHttp('PUT', `/pix/v2/cob/${txid}`, { token, body: {
    calendario: { expiracao: 3600 },
    valor: { original: Number(valor).toFixed(2) },
    chave: INTER.chave,
    solicitacaoPagador: String(solicitacao || '').slice(0, 140)
  }});
}
async function interConsultarCob(txid) {
  const token = await interToken();
  return interHttp('GET', `/pix/v2/cob/${txid}`, { token });
}
async function marcarPreInscricaoPaga(preId) {
  const r = await pool.query(
    `UPDATE pre_inscricoes SET status='pago', pago_em=NOW() WHERE id=$1 AND status='aguardando_pagamento' RETURNING id`,
    [preId]);
  return r.rows.length > 0;
}

// Gera (ou reaproveita) a cobrança PIX da taxa de uma pré-inscrição
app.post('/publico/pre-inscricao/:id/pix', limiterPublico, async (req, res) => {
  try {
    if (!interConfigurado()) return res.status(503).json({ erro: 'Pagamento via PIX ainda não está configurado.' });
    const q = await pool.query(`SELECT * FROM pre_inscricoes WHERE id = $1`, [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ erro: 'Pré-inscrição não encontrada.' });
    const pre = q.rows[0];
    if (['pago', 'efetivada'].includes(pre.status)) return res.status(409).json({ erro: 'Esta inscrição já foi paga.' });
    const valor = Number(pre.valor_taxa);
    if (!(valor > 0)) return res.status(400).json({ erro: 'Valor da taxa inválido para cobrança.' });

    let txid = pre.mp_payment_id;
    let copiaCola = pre.pix_copia_cola;
    if (!txid || !copiaCola) {
      txid = crypto.randomBytes(16).toString('hex'); // 32 caracteres alfanuméricos
      const cob = await interCriarCob(txid, valor, `Taxa de matricula CEMIC ${pre.protocolo || ''}`.trim());
      copiaCola = cob.pixCopiaECola;
      await pool.query(`UPDATE pre_inscricoes SET mp_payment_id=$1, pix_copia_cola=$2 WHERE id=$3`, [txid, copiaCola, pre.id]);
    }
    res.json({ txid, copia_cola: copiaCola, valor, expiracao: 3600 });
  } catch (e) { console.error('Erro gerar PIX Inter:', e); res.status(500).json({ erro: 'Não foi possível gerar o PIX agora. Tente novamente.' }); }
});

// Consulta de status (polling) — confirma na API do Inter antes de marcar pago
app.get('/publico/pre-inscricao/:id/status', limiterPublico, async (req, res) => {
  try {
    const q = await pool.query(`SELECT id, protocolo, status, mp_payment_id FROM pre_inscricoes WHERE id = $1`, [req.params.id]);
    if (!q.rows.length) return res.status(404).json({ erro: 'Pré-inscrição não encontrada.' });
    const pre = q.rows[0];
    if (['pago', 'efetivada'].includes(pre.status)) return res.json({ status: 'pago', protocolo: pre.protocolo });
    if (interConfigurado() && pre.mp_payment_id) {
      try {
        const cob = await interConsultarCob(pre.mp_payment_id);
        if (cob && cob.status === 'CONCLUIDA') { await marcarPreInscricaoPaga(pre.id); return res.json({ status: 'pago', protocolo: pre.protocolo }); }
      } catch (e) { console.error('Status: erro consultar cob:', e.message); }
    }
    res.json({ status: pre.status });
  } catch (e) { console.error('Erro status pré-inscrição:', e); res.status(500).json({ erro: 'Erro ao consultar o status.' }); }
});

// Webhook do Inter (sem rate limit; responde 200 rápido e confirma por consulta)
app.post('/publico/pix/webhook', async (req, res) => {
  try {
    const corpo = req.body || {};
    const lista = Array.isArray(corpo) ? corpo : (Array.isArray(corpo.pix) ? corpo.pix : []);
    for (const p of lista) {
      const txid = p && p.txid;
      if (!txid) continue;
      const q = await pool.query(`SELECT id, status FROM pre_inscricoes WHERE mp_payment_id = $1`, [txid]);
      if (!q.rows.length || ['pago', 'efetivada'].includes(q.rows[0].status)) continue;
      try {
        const cob = await interConsultarCob(txid);
        if (cob && cob.status === 'CONCLUIDA') await marcarPreInscricaoPaga(q.rows[0].id);
      } catch (e) { console.error('Webhook: erro consultar cob:', e.message); }
    }
  } catch (e) { console.error('Erro webhook Inter:', e); }
  res.status(200).json({ ok: true });
});

// Registro do webhook no Inter (operação única, feita pelo master)
app.post('/admin/inter/webhook', autenticar, exigirPerfil('master'), async (req, res) => {
  try {
    if (!interConfigurado()) return res.status(503).json({ erro: 'Inter não configurado.' });
    const url = String(req.body.url || '').trim();
    if (!/^https:\/\//.test(url)) return res.status(400).json({ erro: 'Informe a URL HTTPS do webhook.' });
    const token = await interToken();
    await interHttp('PUT', `/pix/v2/webhook/${encodeURIComponent(INTER.chave)}`, { token, body: { webhookUrl: url } });
    res.json({ mensagem: 'Webhook registrado no Inter.', url });
  } catch (e) { console.error('Erro registrar webhook Inter:', e); res.status(500).json({ erro: 'Erro ao registrar webhook: ' + e.message }); }
});

app.use(express.static(PASTA_PUBLIC));
app.get('/', (req, res) => {
  const arquivo = path.join(PASTA_PUBLIC, 'index.html');
  if (fs.existsSync(arquivo)) return res.sendFile(arquivo);
  res.status(200).send('CEMIC Gestão — backend no ar. Adicione o index.html na pasta /public do repositório para servir o sistema por aqui.');
});

// ============================================================
// 12. SAÚDE E INICIALIZAÇÃO
// ============================================================
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', sistema: 'CEMIC Gestão', versao: '3.11 (Portal dos Pais + Pix Inter)' });
  } catch {
    res.status(500).json({ status: 'erro', detalhe: 'Banco de dados inacessível.' });
  }
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`CEMIC Gestão — backend v3.11 rodando na porta ${PORT}`)))
  .catch(e => { console.error('Falha ao inicializar o banco:', e); process.exit(1); });
