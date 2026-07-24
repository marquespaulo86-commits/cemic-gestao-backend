// ============================================================
// SISTEMA DE GESTÃO ESCOLAR CEMIC — Backend v3.35 (… + Portal dos Pais + Pix Inter)
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
app.use(express.json({ limit: '12mb' }));

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
    modalidade TEXT NOT NULL DEFAULT 'pagante' CHECK (modalidade IN ('pagante','pagante_parcial','bolsista','bolsista_iema','desconto_especial')),
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
    frequencia_final NUMERIC(5,2)
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
  await pool.query(`ALTER TABLE pre_inscricoes ADD COLUMN IF NOT EXISTS semestre TEXT`);
  await pool.query(`ALTER TABLE pre_inscricoes ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'pre_inscricao'`);
  // Matrícula: a unicidade passa a valer só para matrícula que ocupa vaga (ativa/trancada).
  // Assim, matrícula cancelada ou concluída não impede nova matrícula na mesma turma.
  await pool.query(`ALTER TABLE matriculas DROP CONSTRAINT IF EXISTS matriculas_aluno_id_turma_id_key`);
  await pool.query(`ALTER TABLE alunos DROP CONSTRAINT IF EXISTS alunos_modalidade_check`);
  await pool.query(`ALTER TABLE alunos ADD CONSTRAINT alunos_modalidade_check CHECK (modalidade IN ('pagante','pagante_parcial','bolsista','bolsista_iema','desconto_especial'))`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_matricula_vaga ON matriculas (aluno_id, turma_id) WHERE status IN ('ativa','trancada')`);
  // Portal dos Pais: senha do responsável (primeiro acesso)
  await pool.query(`ALTER TABLE responsaveis ADD COLUMN IF NOT EXISTS senha_hash TEXT`);
  // Declarações emitidas (verificáveis por código)
  await pool.query(`CREATE TABLE IF NOT EXISTS declaracoes (
    id SERIAL PRIMARY KEY,
    codigo TEXT UNIQUE NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'vinculo',
    aluno_id INTEGER REFERENCES alunos(id) ON DELETE SET NULL,
    aluno_nome TEXT NOT NULL,
    aluno_cpf TEXT,
    curso TEXT,
    modulo TEXT,
    turno TEXT,
    semestre TEXT,
    responsavel_id INTEGER REFERENCES responsaveis(id) ON DELETE SET NULL,
    emitida_em TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`ALTER TABLE declaracoes ADD COLUMN IF NOT EXISTS modulo TEXT`);
  await pool.query(`ALTER TABLE declaracoes ADD COLUMN IF NOT EXISTS semestre TEXT`);
  await pool.query(`ALTER TABLE declaracoes ADD COLUMN IF NOT EXISTS modulos JSONB`);
  await pool.query(`ALTER TABLE declaracoes ADD COLUMN IF NOT EXISTS total_semestres INTEGER`);
  await pool.query(`ALTER TABLE declaracoes ADD COLUMN IF NOT EXISTS carga_horaria INTEGER`);
  await pool.query(`ALTER TABLE declaracoes ADD COLUMN IF NOT EXISTS emitida_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL`);
  // Folha de professores (hora-aula)
  await pool.query(`CREATE TABLE IF NOT EXISTS professor_horas (
    id SERIAL PRIMARY KEY,
    professor_id INTEGER NOT NULL REFERENCES professores(id) ON DELETE CASCADE,
    data DATE NOT NULL,
    horas NUMERIC(6,2) NOT NULL,
    valor_hora NUMERIC(10,2) NOT NULL,
    observacao TEXT,
    criado_em TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`ALTER TABLE professores ADD COLUMN IF NOT EXISTS cpf TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS professor_pagamentos (
    id SERIAL PRIMARY KEY,
    professor_id INTEGER NOT NULL REFERENCES professores(id) ON DELETE CASCADE,
    referencia TEXT NOT NULL,
    data_pagamento DATE NOT NULL,
    valor NUMERIC(10,2) NOT NULL,
    forma TEXT,
    observacao TEXT,
    criado_em TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_prof_pag_ref ON professor_pagamentos (professor_id, referencia)`);
  // ---------- Portal do Professor ----------
  await pool.query(`ALTER TABLE aulas ADD COLUMN IF NOT EXISTS professor_id INTEGER REFERENCES professores(id) ON DELETE SET NULL`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ocorrencias (
    id SERIAL PRIMARY KEY,
    aluno_id INTEGER NOT NULL REFERENCES alunos(id) ON DELETE CASCADE,
    turma_id INTEGER REFERENCES turmas(id) ON DELETE SET NULL,
    professor_id INTEGER REFERENCES professores(id) ON DELETE SET NULL,
    data DATE NOT NULL DEFAULT CURRENT_DATE,
    tipo TEXT NOT NULL DEFAULT 'pedagogica' CHECK (tipo IN ('comportamento','pedagogica','elogio','saude','outro')),
    titulo TEXT NOT NULL,
    descricao TEXT NOT NULL,
    visivel_responsavel BOOLEAN NOT NULL DEFAULT TRUE,
    criado_em TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS atividades (
    id SERIAL PRIMARY KEY,
    turma_id INTEGER NOT NULL REFERENCES turmas(id) ON DELETE CASCADE,
    professor_id INTEGER REFERENCES professores(id) ON DELETE SET NULL,
    titulo TEXT NOT NULL,
    descricao TEXT,
    link TEXT,
    data_entrega DATE,
    criado_em TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS atividade_arquivos (
    id SERIAL PRIMARY KEY,
    atividade_id INTEGER NOT NULL REFERENCES atividades(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    mime TEXT NOT NULL,
    tamanho INTEGER NOT NULL,
    conteudo BYTEA NOT NULL,
    enviado_em TIMESTAMP DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ocorrencias_aluno ON ocorrencias (aluno_id, data)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_atividades_turma ON atividades (turma_id, criado_em)`);
  // ---------- Carteira Estudantil (v3.32) ----------
  await migrar('aluno_fotos', `CREATE TABLE IF NOT EXISTS aluno_fotos (
    aluno_id INTEGER PRIMARY KEY REFERENCES alunos(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    tamanho INTEGER NOT NULL,
    conteudo BYTEA NOT NULL,
    enviada_por INTEGER REFERENCES responsaveis(id) ON DELETE SET NULL,
    enviada_em TIMESTAMP DEFAULT NOW()
  )`);
  await migrar('carteiras', `CREATE TABLE IF NOT EXISTS carteiras (
    id SERIAL PRIMARY KEY,
    codigo TEXT UNIQUE NOT NULL,
    aluno_id INTEGER REFERENCES alunos(id) ON DELETE SET NULL,
    aluno_nome TEXT NOT NULL,
    aluno_cpf TEXT,
    aluno_codigo TEXT,
    curso TEXT,
    modulo TEXT,
    turma_nome TEXT,
    turno TEXT,
    semestre TEXT NOT NULL,
    validade DATE,
    emitida_em TIMESTAMP DEFAULT NOW(),
    emitida_por_responsavel INTEGER REFERENCES responsaveis(id) ON DELETE SET NULL
  )`);
  await migrar('carteiras', `ALTER TABLE carteiras ADD COLUMN IF NOT EXISTS aluno_cpf TEXT`);
  await migrar('idx_carteiras_aluno_semestre', `CREATE UNIQUE INDEX IF NOT EXISTS idx_carteiras_aluno_semestre ON carteiras (aluno_id, semestre)`);
  // ---------- Calendário acadêmico, Circulares e Sistema de Avaliação (v3.33) ----------
  await migrar('avaliacoes', `ALTER TABLE avaliacoes ADD COLUMN IF NOT EXISTS bimestre INTEGER`);
  await migrar('calendario', `CREATE TABLE IF NOT EXISTS calendario (
    id SERIAL PRIMARY KEY,
    semestre TEXT NOT NULL,
    data DATE NOT NULL,
    titulo TEXT NOT NULL,
    detalhe TEXT,
    modalidade TEXT NOT NULL DEFAULT 'Presencial',
    criado_em TIMESTAMP DEFAULT NOW()
  )`);
  await migrar('idx_calendario_evento', `CREATE UNIQUE INDEX IF NOT EXISTS idx_calendario_evento ON calendario (semestre, data, titulo)`);
  await migrar('circulares', `CREATE TABLE IF NOT EXISTS circulares (
    id SERIAL PRIMARY KEY,
    numero TEXT,
    titulo TEXT NOT NULL,
    corpo TEXT NOT NULL,
    destino TEXT NOT NULL DEFAULT 'professores',
    semestre TEXT,
    publicada BOOLEAN NOT NULL DEFAULT TRUE,
    criada_em TIMESTAMP DEFAULT NOW(),
    criada_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL
  )`);
  await migrar('circular_leituras', `CREATE TABLE IF NOT EXISTS circular_leituras (
    circular_id INTEGER NOT NULL REFERENCES circulares(id) ON DELETE CASCADE,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    lida_em TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (circular_id, usuario_id)
  )`);
  try { await seedCalendario(); } catch (e) { falhasMigracao.push('seed calendario: ' + e.message); console.error('Falha ao semear o calendário:', e.message); }
  try { await seedConfiguracoes(); } catch (e) { falhasMigracao.push('seed configuracoes: ' + e.message); console.error('Falha ao semear as configurações:', e.message); }
  await seedCursosNiveis();
  await seedMaster();
  console.log('Banco verificado/criado com sucesso.');
}

// ---------- Seeds de configurações padrão ----------
// Calendário oficial 2026.2 — semeado uma única vez; edições da Gestão nunca são sobrescritas
// Migração tolerante: registra a falha e segue, para um erro pontual não derrubar o sistema inteiro
const falhasMigracao = [];
async function migrar(rotulo, sql) {
  try { await pool.query(sql); }
  catch (e) {
    falhasMigracao.push(rotulo + ': ' + e.message);
    console.error(`MIGRAÇÃO FALHOU [${rotulo}] — ${e.message}`);
  }
}

async function seedCalendario() {
  const SEMESTRE = '2026.2';
  const existe = await pool.query(`SELECT 1 FROM calendario WHERE semestre = $1 LIMIT 1`, [SEMESTRE]);
  if (existe.rows.length) return;
  const IEMA = 'Plataforma Virtual · Sábado letivo IEMA Pleno Dr.º João Bacelar Portela';
  const eventos = [
    ['2026-08-01', 'TCAA / Acolhimento', 'Aplicação do Teste de Conhecimentos Acumulados dos (as) alunos (as)', 'Presencial'],
    ['2026-08-08', 'Aula I', null, 'Presencial'],
    ['2026-08-15', 'Aula II', null, 'Presencial'],
    ['2026-08-22', 'Aula III', IEMA, 'Online'],
    ['2026-08-29', 'Aula IV', null, 'Presencial'],
    ['2026-09-05', 'Aula V', null, 'Presencial'],
    ['2026-09-12', 'Aula VI', IEMA, 'Online'],
    ['2026-09-19', 'Aula VII', null, 'Presencial'],
    ['2026-09-26', 'Aula VIII', null, 'Presencial'],
    ['2026-10-03', 'Aula IX', 'Plataforma Virtual · Eleições 2026', 'Online'],
    ['2026-10-10', 'Aula X', IEMA, 'Online'],
    ['2026-10-17', 'Aula XI', null, 'Presencial'],
    ['2026-10-24', 'Aula XII', IEMA, 'Online'],
    ['2026-10-31', 'Aula XIII', null, 'Presencial'],
    ['2026-11-07', 'Aula XIV', IEMA, 'Online'],
    ['2026-11-14', 'Aula XV', null, 'Presencial'],
    ['2026-11-21', 'Aula XVI', null, 'Presencial'],
    ['2026-11-28', 'Aula XVII', IEMA, 'Online'],
    ['2026-12-05', 'Aula XVIII', null, 'Presencial'],
    ['2026-12-12', 'II Avaliação', null, 'Presencial'],
    ['2026-12-19', 'Recuperação / Prova Final', null, 'Presencial'],
    ['2027-01-09', 'Rematrícula 2027.1', 'Rematrícula para o semestre 2027.1', 'Presencial'],
    ['2027-01-16', 'Rematrícula 2027.1', 'Rematrícula para o semestre 2027.1', 'Presencial']
  ];
  for (const [data, titulo, detalhe, modalidade] of eventos) {
    await pool.query(
      `INSERT INTO calendario (semestre, data, titulo, detalhe, modalidade) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (semestre, data, titulo) DO NOTHING`,
      [SEMESTRE, data, titulo, detalhe, modalidade]);
  }
  console.log('Calendário 2026.2 semeado.');
}

async function seedConfiguracoes() {
  const padroes = [
    ['semestre_vigente', JSON.stringify('2026.2'), 'Semestre letivo vigente (formato AAAA.S)'],
    ['capacidade_padrao_turma', JSON.stringify(15), 'Capacidade padrão de alunos por turma (ajustável por turma)'],
    ['media_aprovacao', JSON.stringify(7), 'Média mínima para aprovação (0 a 10)'],
    ['frequencia_minima', JSON.stringify(75), 'Frequência mínima para aprovação (%)'],
    ['parcelas_semestre', JSON.stringify(6), 'Quantidade de mensalidades geradas por matrícula no semestre'],
    ['dia_vencimento', JSON.stringify(10), 'Dia padrão de vencimento das mensalidades'],
    ['taxa_matricula', JSON.stringify(0), 'Valor padrão da taxa de matrícula (R$) — ajustável no ato, paga sempre no ato'],
    ['valor_plataforma', JSON.stringify(35), 'Valor da Taxa da Plataforma Acadêmica (R$) — lançada 1x por semestre'],
    ['desconto_pontualidade', JSON.stringify(30), 'Desconto de pontualidade (R$) abatido da mensalidade paga até o vencimento'],
    ['multa_atraso', JSON.stringify({ ativa: false, multa_percentual: 2, juros_dia_percentual: 0.033 }), 'Multa e juros por atraso (aplicados quando ativa = true)'],
    ['descontos_disponiveis', JSON.stringify([25, 50, 100]), 'Percentuais de desconto disponíveis para Pagante Parcial (bolsista = 100)'],
    ['mensalidades', JSON.stringify({ 'Inglês': 0, 'Espanhol': 0 }), 'Valor da mensalidade integral por curso (R$) — definir antes das matrículas'],
    ['formas_pagamento', JSON.stringify(['PIX', 'DINHEIRO', 'CARTÃO DE CRÉDITO', 'CARTÃO DE DÉBITO', 'TRANSFERÊNCIA', 'MISTO']), 'Formas de pagamento aceitas'],
    ['categorias_contas_pagar', JSON.stringify(['Aluguel', 'Energia', 'Água/Internet', 'Salários', 'Material Didático', 'Manutenção', 'Outros']), 'Categorias de contas a pagar'],
    ['categorias_contas_receber', JSON.stringify(['Mensalidade', 'Matrícula', 'Material', 'Evento', 'Outros']), 'Categorias de contas a receber'],
    ['dados_instituicao', JSON.stringify({
      nome: 'Centro Maranhense de Idiomas e Culturas — CEMIC',
      cnpj: '24.203.264/0001-00', endereco: 'São Luís - MA', telefone: '', email: '', logo_url: ''
    }), 'Dados institucionais usados em documentos e PDFs'],
    ['modelo_boletim', JSON.stringify({ titulo: 'Boletim de Desempenho', exibir_frequencia: true, exibir_observacoes: true, rodape: 'Documento emitido pelo CEMIC.' }), 'Modelo do boletim do aluno'],
    ['modelo_historico', JSON.stringify({ titulo: 'Histórico Escolar', exibir_carga_horaria: true, rodape: 'Documento emitido pelo CEMIC.' }), 'Modelo do histórico do aluno'],
    ['sistema_avaliacao', JSON.stringify({
      bimestres: 2,
      nota_maxima: 10,
      etapas: {
        '1': [
          { nome: 'Participação nas atividades', peso: 1 },
          { nome: 'Prova escrita', peso: 1 },
          { nome: 'Desempenho na Plataforma', peso: 1 }
        ],
        '2': [
          { nome: 'Prova escrita', peso: 1 },
          { nome: 'Prova oral', peso: 1 },
          { nome: 'Desempenho na Plataforma', peso: 1 }
        ]
      }
    }), 'Composição da nota por bimestre (etapas e pesos) — base para as avaliações das turmas'],
    ['calendario_observacao', JSON.stringify('O presente calendário está sujeito a modificações, considerando o Calendário Escolar Regular do IEMA Pleno Dr.º João Bacelar Portela.'), 'Observação exibida ao pé do calendário acadêmico']
    ['valor_hora_aula', JSON.stringify(0), 'Valor padrão da hora-aula do professor (R$)']
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

function autenticarResponsavel(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Sessão não encontrada. Faça login.' });
  try {
    const dados = jwt.verify(token, JWT_SECRET);
    if (dados.perfil !== 'responsavel') return res.status(403).json({ erro: 'Acesso negado.' });
    req.responsavelId = dados.responsavel_id;
    req.responsavelNome = dados.nome;
    next();
  } catch {
    return res.status(401).json({ erro: 'Sessão inválida ou expirada. Faça login novamente.' });
  }
}
async function alunosDoResponsavel(respId) {
  const r = await pool.query(
    `SELECT a.id, a.nome, a.cpf, a.data_nascimento,
            t.nome AS turma_nome, t.turno, n.nome AS nivel_nome, c.nome AS curso_nome
     FROM aluno_responsavel ar
     JOIN alunos a ON a.id = ar.aluno_id
     LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.status = 'ativa'
     LEFT JOIN turmas t ON t.id = m.turma_id
     LEFT JOIN niveis n ON n.id = t.nivel_id
     LEFT JOIN cursos c ON c.id = n.curso_id
     WHERE ar.responsavel_id = $1
     ORDER BY a.nome`, [respId]);
  return r.rows;
}

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
    // Nunca devolver senha_hash ao frontend — apenas se o acesso ao portal já foi criado
    const r = await pool.query(
      `SELECT id, nome, cpf, email, whatsapp, (senha_hash IS NOT NULL) AS cadastrado
       FROM responsaveis ${where} ORDER BY nome`, params);
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

// Redefinir acesso: apaga a senha para o responsável refazer o primeiro acesso
app.post('/admin/responsaveis/:id/redefinir-acesso', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE responsaveis SET senha_hash = NULL WHERE id = $1 RETURNING nome, cpf`, [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ erro: 'Responsável não encontrado.' });
    console.log(`Acesso ao Portal redefinido: responsável ${r.rows[0].nome} por usuário ${req.usuario.id}`);
    res.json({ ok: true, nome: r.rows[0].nome });
  } catch (e) { console.error('Erro redefinir acesso:', e); res.status(500).json({ erro: 'Erro ao redefinir o acesso.' }); }
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
      `INSERT INTO professores (nome, cpf, email, formacao, whatsapp, data_nascimento) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.body.nome, req.body.cpf || null, req.body.email || null, req.body.formacao || null, req.body.whatsapp || null, req.body.data_nascimento || null]
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
      `UPDATE professores SET nome=$1, cpf=$2, email=$3, formacao=$4, whatsapp=$5, data_nascimento=$6, status=$7 WHERE id=$8 RETURNING *`,
      [
        req.body.nome ?? x.nome, req.body.cpf ?? x.cpf, req.body.email ?? x.email, req.body.formacao ?? x.formacao,
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

    const dupq = await client.query(`SELECT 1 FROM matriculas WHERE aluno_id = $1 AND turma_id = $2 AND status IN ('ativa','trancada')`, [aluno.id, turma.id]);
    if (dupq.rows.length) { await client.query('ROLLBACK'); client.release(); return res.status(409).json({ erro: 'O aluno já possui matrícula ativa nesta turma.' }); }

    const ocup = await client.query(`SELECT COUNT(*)::int AS n FROM matriculas WHERE turma_id = $1 AND status = 'ativa'`, [turma.id]);
    if (ocup.rows[0].n >= turma.capacidade) {
      await client.query('ROLLBACK'); client.release();
      return res.status(409).json({ erro: `Turma lotada — capacidade de ${turma.capacidade} alunos atingida.` });
    }

    const bolsista = aluno.modalidade === 'bolsista';
    // Bolsista IEMA e Desconto Especial: isentos de mensalidade e taxa de matrícula, mas pagam a Plataforma
    const isentoMensTaxa = aluno.modalidade === 'bolsista_iema' || aluno.modalidade === 'desconto_especial';
    const hoje = new Date();
    const diaVenc = Math.min(Number(await getConfig('dia_vencimento', 10)) || 10, 28);

    // Esquema de lançamento financeiro escolhido no ato:
    // '1' = 1º semestre (fev–jun) · '2' = 2º semestre (ago–dez) · 'sem' = sem financeiro (bolsista)
    let semLanc = String(req.body.semestre_lancamento || '').trim();
    if (!['1', '2', 'sem'].includes(semLanc)) {
      semLanc = (bolsista || isentoMensTaxa) ? 'sem' : (String(turma.semestre || '').endsWith('.1') ? '1' : '2');
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
    const taxa = isentoMensTaxa ? 0 : (req.body.taxa_matricula !== undefined
      ? Number(req.body.taxa_matricula) || 0
      : Number(await getConfig('taxa_matricula', 0)) || 0);
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
      const platSemestre = String(turma.semestre || '').endsWith('.1') ? '2' : '8';
      if (isentoMensTaxa) { platMes = platSemestre; }        // IEMA/Especial pagam a Plataforma
      else { platMes = querPlat && semLanc !== 'sem' ? platSemestre : 'sem'; }
    }
    if (platMes === '2' || platMes === '8') {
      const valorPlat = Number(req.body.valor_plataforma) || Number(await getConfig('valor_plataforma', 35)) || 35;
      const mesPlat = platMes === '2' ? 1 : 7;
      const vencPlat = new Date(anoBase, mesPlat, 5); // 05/02 ou 05/08 — mesma data impressa no termo
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
app.get('/publico/instituicao', limiterPublico, async (req, res) => {
  try {
    const inst = await getConfig('dados_instituicao', {}) || {};
    res.json({
      nome: inst.nome || 'Centro Maranhense de Idiomas e Culturas — CEMIC',
      cnpj: inst.cnpj || '',
      endereco: inst.endereco || '',
      telefone: inst.telefone || '',
      email: inst.email || ''
    });
  } catch (e) { console.error('Erro GET instituicao:', e); res.status(500).json({ erro: 'Erro ao carregar os dados institucionais.' }); }
});

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

app.post('/publico/rematricula', limiterPublico, async (req, res) => {
  try {
    const alunoNome = String(req.body.aluno_nome || '').trim();
    const alunoCpf = String(req.body.aluno_cpf || '').trim();
    const nasc = String(req.body.aluno_data_nascimento || '').trim();
    const turno = String(req.body.turno || '').trim();
    const semestre = String(req.body.semestre || '').trim();
    const respNome = String(req.body.responsavel_nome || '').trim();
    const respCpf = String(req.body.responsavel_cpf || '').trim();
    const respZap = String(req.body.responsavel_whatsapp || '').trim();
    const respEmail = String(req.body.responsavel_email || '').trim();
    const parentesco = String(req.body.parentesco || '').trim();
    const aceite = req.body.aceite_termos === true || req.body.aceite_termos === 'true';

    if (!alunoNome) return res.status(400).json({ erro: 'Informe o nome do aluno.' });
    if (!alunoCpf) return res.status(400).json({ erro: 'Informe o CPF do aluno.' });
    if (!semestre) return res.status(400).json({ erro: 'Selecione o semestre.' });
    if (turno !== 'Matutino' && turno !== 'Vespertino') return res.status(400).json({ erro: 'Selecione o turno (Matutino ou Vespertino).' });
    if (!respNome) return res.status(400).json({ erro: 'Informe o nome do responsável.' });
    if (!respZap && !respEmail) return res.status(400).json({ erro: 'Informe ao menos um contato do responsável (WhatsApp ou e-mail).' });
    if (!aceite) return res.status(400).json({ erro: 'É necessário estar ciente do Termo do semestre.' });

    let nascVal = null;
    if (nasc) { const dn = new Date(nasc + 'T12:00:00'); if (!isNaN(dn.getTime())) nascVal = nasc; }
    const taxa = Number(await getConfig('taxa_matricula', 0)) || 0;

    const r = await pool.query(
      `INSERT INTO pre_inscricoes
         (tipo, semestre, aluno_nome, aluno_data_nascimento, aluno_cpf, turno,
          responsavel_nome, responsavel_cpf, responsavel_whatsapp, responsavel_email, parentesco, valor_taxa)
       VALUES ('rematriculaonline',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [semestre, alunoNome.toUpperCase(), nascVal, alunoCpf, turno,
       respNome.toUpperCase(), respCpf || null, respZap || null, respEmail || null, parentesco || null, taxa]);
    const id = r.rows[0].id;
    const protocolo = `REM-${new Date().getFullYear()}-${String(id).padStart(6, '0')}`;
    await pool.query(`UPDATE pre_inscricoes SET protocolo = $1 WHERE id = $2`, [protocolo, id]);

    res.status(201).json({
      id, protocolo, semestre, turno, valor_taxa: taxa,
      mensagem: 'Rematrícula registrada. Prossiga para o pagamento da taxa via PIX.'
    });
  } catch (e) { console.error('Erro /publico/rematricula:', e); res.status(500).json({ erro: 'Erro ao registrar a rematrícula.' }); }
});

app.post('/publico/portal/primeiro-acesso', limiterLogin, async (req, res) => {
  try {
    const cpf = soDigitos(req.body.cpf);
    const senha = String(req.body.senha || '');
    if (!cpf) return res.status(400).json({ erro: 'Informe o CPF.' });
    if (senha.length < 6) return res.status(400).json({ erro: 'A senha deve ter ao menos 6 caracteres.' });
    const r = await pool.query(`SELECT id, senha_hash FROM responsaveis WHERE cpf = $1`, [cpf]);
    const resp = r.rows[0];
    if (!resp) return res.status(404).json({ erro: 'CPF não encontrado. Confirme com a secretaria se você está cadastrado como responsável do aluno.' });
    if (resp.senha_hash) return res.status(409).json({ erro: 'Você já possui senha cadastrada. Faça login.' });
    const hash = await bcrypt.hash(senha, 10);
    await pool.query(`UPDATE responsaveis SET senha_hash = $1 WHERE id = $2`, [hash, resp.id]);
    res.status(201).json({ mensagem: 'Senha cadastrada com sucesso. Agora é só fazer login.' });
  } catch (e) { console.error('Erro portal primeiro-acesso:', e); res.status(500).json({ erro: 'Erro ao cadastrar a senha.' }); }
});

app.post('/publico/portal/login', limiterLogin, async (req, res) => {
  try {
    const cpf = soDigitos(req.body.cpf);
    const senha = String(req.body.senha || '');
    if (!cpf || !senha) return res.status(400).json({ erro: 'Informe CPF e senha.' });
    const r = await pool.query(`SELECT id, nome, senha_hash FROM responsaveis WHERE cpf = $1`, [cpf]);
    const resp = r.rows[0];
    if (!resp) return res.status(401).json({ erro: 'CPF ou senha inválidos.' });
    if (!resp.senha_hash) return res.status(409).json({ erro: 'Primeiro acesso necessário. Toque em "Primeiro acesso" para cadastrar sua senha.' });
    const ok = await bcrypt.compare(senha, resp.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'CPF ou senha inválidos.' });
    const token = jwt.sign({ responsavel_id: resp.id, nome: resp.nome, perfil: 'responsavel' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, responsavel: { nome: resp.nome }, alunos: await alunosDoResponsavel(resp.id) });
  } catch (e) { console.error('Erro portal login:', e); res.status(500).json({ erro: 'Erro ao entrar.' }); }
});

app.get('/publico/portal/alunos', autenticarResponsavel, async (req, res) => {
  try { res.json(await alunosDoResponsavel(req.responsavelId)); }
  catch (e) { console.error('Erro portal alunos:', e); res.status(500).json({ erro: 'Erro ao carregar os alunos.' }); }
});

// ---------- Avisos (coordenação publica; pais leem no portal) ----------
app.post('/admin/avisos', autenticar, somenteGestao, async (req, res) => {
  try {
    const escopo = ['geral', 'turma', 'aluno'].includes(req.body.escopo) ? req.body.escopo : 'geral';
    const titulo = String(req.body.titulo || '').trim();
    const mensagem = String(req.body.mensagem || '').trim();
    if (!titulo) return res.status(400).json({ erro: 'Informe o título.' });
    if (!mensagem) return res.status(400).json({ erro: 'Informe a mensagem.' });
    let turmaId = null, alunoId = null;
    if (escopo === 'turma') { turmaId = Number(req.body.turma_id) || null; if (!turmaId) return res.status(400).json({ erro: 'Selecione a turma.' }); }
    if (escopo === 'aluno') { alunoId = Number(req.body.aluno_id) || null; if (!alunoId) return res.status(400).json({ erro: 'Selecione o aluno.' }); }
    const r = await pool.query(
      `INSERT INTO avisos (autor_id, escopo, turma_id, aluno_id, titulo, mensagem)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.usuario.id, escopo, turmaId, alunoId, titulo, mensagem]);
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) { console.error('Erro POST avisos:', e); res.status(500).json({ erro: 'Erro ao publicar o aviso.' }); }
});

app.get('/admin/avisos', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT av.id, av.escopo, av.titulo, av.mensagem, av.criado_em, av.turma_id, av.aluno_id,
              t.nome AS turma_nome, a.nome AS aluno_nome, u.nome AS autor_nome
       FROM avisos av
       LEFT JOIN turmas t ON t.id = av.turma_id
       LEFT JOIN alunos a ON a.id = av.aluno_id
       LEFT JOIN usuarios u ON u.id = av.autor_id
       ORDER BY av.criado_em DESC LIMIT 200`);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET avisos:', e); res.status(500).json({ erro: 'Erro ao listar avisos.' }); }
});

app.delete('/admin/avisos/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM avisos WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Aviso não encontrado.' });
    res.json({ ok: true });
  } catch (e) { console.error('Erro DELETE avisos:', e); res.status(500).json({ erro: 'Erro ao remover o aviso.' }); }
});

app.get('/publico/portal/aluno/:id/avisos', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    const vinc = await pool.query(
      `SELECT 1 FROM aluno_responsavel WHERE responsavel_id = $1 AND aluno_id = $2`,
      [req.responsavelId, alunoId]);
    if (!vinc.rows.length) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const r = await pool.query(
      `SELECT av.id, av.escopo, av.titulo, av.mensagem, av.criado_em, t.nome AS turma_nome
       FROM avisos av
       LEFT JOIN turmas t ON t.id = av.turma_id
       WHERE av.escopo = 'geral'
          OR (av.escopo = 'aluno' AND av.aluno_id = $1)
          OR (av.escopo = 'turma' AND av.turma_id IN (
                SELECT turma_id FROM matriculas WHERE aluno_id = $1 AND status = 'ativa'))
       ORDER BY av.criado_em DESC LIMIT 100`, [alunoId]);
    res.json(r.rows);
  } catch (e) { console.error('Erro portal avisos:', e); res.status(500).json({ erro: 'Erro ao carregar os avisos.' }); }
});

// ---------- Declaração de Vínculo verificável ----------
app.post('/publico/portal/aluno/:id/declaracao', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    const vinc = await pool.query(`SELECT 1 FROM aluno_responsavel WHERE responsavel_id = $1 AND aluno_id = $2`, [req.responsavelId, alunoId]);
    if (!vinc.rows.length) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const dr = await pool.query(
      `SELECT a.nome, a.cpf, t.turno, t.semestre, n.nome AS nivel_nome
       FROM alunos a
       LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.status = 'ativa'
       LEFT JOIN turmas t ON t.id = m.turma_id
       LEFT JOIN niveis n ON n.id = t.nivel_id
       WHERE a.id = $1 LIMIT 1`, [alunoId]);
    const d = dr.rows[0];
    if (!d) return res.status(404).json({ erro: 'Aluno não encontrado.' });
    const curso = 'Língua e Cultura Inglesa';
    let codigo, ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      codigo = 'CEMIC-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
      const ex = await pool.query(`SELECT 1 FROM declaracoes WHERE codigo = $1`, [codigo]);
      if (!ex.rows.length) ok = true;
    }
    const ins = await pool.query(
      `INSERT INTO declaracoes (codigo, tipo, aluno_id, aluno_nome, aluno_cpf, curso, modulo, turno, semestre, responsavel_id)
       VALUES ($1, 'vinculo', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING codigo, emitida_em`,
      [codigo, alunoId, d.nome, d.cpf, curso, d.nivel_nome || null, d.turno || null, d.semestre || null, req.responsavelId]);
    res.status(201).json({
      codigo: ins.rows[0].codigo, emitida_em: ins.rows[0].emitida_em,
      aluno_nome: d.nome, aluno_cpf: d.cpf, curso, modulo: d.nivel_nome || null, turno: d.turno || null, semestre: d.semestre || null
    });
  } catch (e) { console.error('Erro gerar declaração:', e); res.status(500).json({ erro: 'Erro ao gerar a declaração.' }); }
});

// ============================================================
// PORTAL DO PROFESSOR
// ============================================================
const somenteProfessor = exigirPerfil('professor', 'master', 'secretaria');

// professor -> só as próprias turmas; gestão -> acesso amplo (null)
function escopoProfessor(req) {
  if (req.usuario.perfil === 'professor') return Number(req.usuario.referencia_id) || -1;
  return null;
}
async function podeTurma(req, turmaId) {
  const prof = escopoProfessor(req);
  if (prof === null) return true;
  const r = await pool.query(`SELECT 1 FROM turmas WHERE id = $1 AND professor_id = $2`, [turmaId, prof]);
  return r.rows.length > 0;
}
async function turmaDaAula(aulaId) {
  const r = await pool.query(`SELECT turma_id FROM aulas WHERE id = $1`, [aulaId]);
  return r.rows.length ? r.rows[0].turma_id : null;
}
async function turmaDaAvaliacao(avId) {
  const r = await pool.query(`SELECT turma_id FROM avaliacoes WHERE id = $1`, [avId]);
  return r.rows.length ? r.rows[0].turma_id : null;
}
const MIMES_OK = {
  'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/gif': 1, 'application/pdf': 1,
  'application/msword': 1,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 1
};
const LIMITE_ARQUIVO = 5 * 1024 * 1024;

// --- Turmas do professor ---
app.get('/professor/turmas', autenticar, somenteProfessor, async (req, res) => {
  try {
    const prof = escopoProfessor(req);
    const cond = prof === null ? '' : 'WHERE t.professor_id = $1';
    const params = prof === null ? [] : [prof];
    const r = await pool.query(
      `SELECT t.id, t.nome, t.semestre, t.turno, t.horario, t.status,
              n.nome AS nivel_nome, c.nome AS curso_nome,
              (SELECT COUNT(*) FROM matriculas m WHERE m.turma_id = t.id AND m.status = 'ativa') AS alunos
       FROM turmas t
       JOIN niveis n ON n.id = t.nivel_id
       JOIN cursos c ON c.id = n.curso_id
       ${cond}
       ORDER BY t.semestre DESC, t.nome`, params);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET professor/turmas:', e); res.status(500).json({ erro: 'Erro ao listar as turmas.' }); }
});

app.get('/professor/turmas/:id/alunos', autenticar, somenteProfessor, async (req, res) => {
  try {
    if (!await podeTurma(req, req.params.id)) return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' });
    const r = await pool.query(
      `SELECT m.id AS matricula_id, a.id AS aluno_id, a.nome, a.cpf
       FROM matriculas m JOIN alunos a ON a.id = m.aluno_id
       WHERE m.turma_id = $1 AND m.status = 'ativa'
       ORDER BY a.nome`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET alunos da turma:', e); res.status(500).json({ erro: 'Erro ao listar os alunos.' }); }
});

// --- Aulas / conteúdos ---
app.get('/professor/turmas/:id/aulas', autenticar, somenteProfessor, async (req, res) => {
  try {
    if (!await podeTurma(req, req.params.id)) return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' });
    const r = await pool.query(
      `SELECT au.id, au.data, au.conteudo,
              (SELECT COUNT(*) FROM frequencias f WHERE f.aula_id = au.id) AS chamada_lancada,
              (SELECT COUNT(*) FROM frequencias f WHERE f.aula_id = au.id AND f.presente = FALSE) AS faltas
       FROM aulas au WHERE au.turma_id = $1 ORDER BY au.data DESC, au.id DESC`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET aulas:', e); res.status(500).json({ erro: 'Erro ao listar as aulas.' }); }
});

app.post('/professor/turmas/:id/aulas', autenticar, somenteProfessor, async (req, res) => {
  try {
    if (!await podeTurma(req, req.params.id)) return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' });
    const data = req.body.data;
    const conteudo = (req.body.conteudo || '').trim();
    if (!data) return res.status(400).json({ erro: 'Informe a data da aula.' });
    if (!conteudo) return res.status(400).json({ erro: 'Descreva o conteúdo trabalhado.' });
    const prof = escopoProfessor(req);
    const r = await pool.query(
      `INSERT INTO aulas (turma_id, data, conteudo, professor_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.params.id, data, conteudo, prof]);
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) { console.error('Erro POST aula:', e); res.status(500).json({ erro: 'Erro ao registrar a aula.' }); }
});

app.put('/professor/aulas/:id', autenticar, somenteProfessor, async (req, res) => {
  try {
    const tId = await turmaDaAula(req.params.id);
    if (!tId) return res.status(404).json({ erro: 'Aula não encontrada.' });
    if (!await podeTurma(req, tId)) return res.status(403).json({ erro: 'Aula de turma não vinculada ao seu cadastro.' });
    const conteudo = (req.body.conteudo || '').trim();
    if (!conteudo) return res.status(400).json({ erro: 'Descreva o conteúdo trabalhado.' });
    await pool.query(`UPDATE aulas SET conteudo = $1, data = COALESCE($2, data) WHERE id = $3`,
      [conteudo, req.body.data || null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('Erro PUT aula:', e); res.status(500).json({ erro: 'Erro ao atualizar a aula.' }); }
});

app.delete('/professor/aulas/:id', autenticar, somenteProfessor, async (req, res) => {
  try {
    const tId = await turmaDaAula(req.params.id);
    if (!tId) return res.status(404).json({ erro: 'Aula não encontrada.' });
    if (!await podeTurma(req, tId)) return res.status(403).json({ erro: 'Aula de turma não vinculada ao seu cadastro.' });
    await pool.query(`DELETE FROM aulas WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('Erro DELETE aula:', e); res.status(500).json({ erro: 'Erro ao remover a aula.' }); }
});

// --- Chamada (frequência) ---
app.get('/professor/aulas/:id/chamada', autenticar, somenteProfessor, async (req, res) => {
  try {
    const tId = await turmaDaAula(req.params.id);
    if (!tId) return res.status(404).json({ erro: 'Aula não encontrada.' });
    if (!await podeTurma(req, tId)) return res.status(403).json({ erro: 'Aula de turma não vinculada ao seu cadastro.' });
    const r = await pool.query(
      `SELECT m.id AS matricula_id, a.nome,
              COALESCE(f.presente, TRUE) AS presente, f.justificativa,
              (f.id IS NOT NULL) AS lancado
       FROM matriculas m
       JOIN alunos a ON a.id = m.aluno_id
       LEFT JOIN frequencias f ON f.matricula_id = m.id AND f.aula_id = $2
       WHERE m.turma_id = $1 AND m.status = 'ativa'
       ORDER BY a.nome`, [tId, req.params.id]);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET chamada:', e); res.status(500).json({ erro: 'Erro ao carregar a chamada.' }); }
});

app.post('/professor/aulas/:id/chamada', autenticar, somenteProfessor, async (req, res) => {
  const client = await pool.connect();
  try {
    const tId = await turmaDaAula(req.params.id);
    if (!tId) { client.release(); return res.status(404).json({ erro: 'Aula não encontrada.' }); }
    if (!await podeTurma(req, tId)) { client.release(); return res.status(403).json({ erro: 'Aula de turma não vinculada ao seu cadastro.' }); }
    const lista = Array.isArray(req.body.presencas) ? req.body.presencas : [];
    if (!lista.length) { client.release(); return res.status(400).json({ erro: 'Nenhuma presença informada.' }); }
    await client.query('BEGIN');
    for (const p of lista) {
      await client.query(
        `INSERT INTO frequencias (aula_id, matricula_id, presente, justificativa)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (aula_id, matricula_id)
         DO UPDATE SET presente = EXCLUDED.presente, justificativa = EXCLUDED.justificativa`,
        [req.params.id, Number(p.matricula_id), p.presente !== false, (p.justificativa || '').trim() || null]);
    }
    await client.query('COMMIT');
    client.release();
    res.json({ ok: true, registros: lista.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); client.release();
    console.error('Erro POST chamada:', e); res.status(500).json({ erro: 'Erro ao salvar a chamada.' });
  }
});

// --- Avaliações e notas ---
app.get('/professor/turmas/:id/avaliacoes', autenticar, somenteProfessor, async (req, res) => {
  try {
    if (!await podeTurma(req, req.params.id)) return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' });
    const r = await pool.query(
      `SELECT av.id, av.nome, av.peso, av.data,
              (SELECT COUNT(*) FROM notas n WHERE n.avaliacao_id = av.id) AS notas_lancadas
       FROM avaliacoes av WHERE av.turma_id = $1 ORDER BY av.data NULLS LAST, av.id`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET avaliacoes:', e); res.status(500).json({ erro: 'Erro ao listar as avaliações.' }); }
});

app.post('/professor/turmas/:id/avaliacoes', autenticar, somenteProfessor, async (req, res) => {
  try {
    if (!await podeTurma(req, req.params.id)) return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' });
    const nome = (req.body.nome || '').trim();
    if (!nome) return res.status(400).json({ erro: 'Informe o nome da avaliação.' });
    const peso = Number(req.body.peso) > 0 ? Number(req.body.peso) : 1;
    const r = await pool.query(
      `INSERT INTO avaliacoes (turma_id, nome, peso, data) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.params.id, nome, peso, req.body.data || null]);
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) { console.error('Erro POST avaliacao:', e); res.status(500).json({ erro: 'Erro ao criar a avaliação.' }); }
});

app.delete('/professor/avaliacoes/:id', autenticar, somenteProfessor, async (req, res) => {
  try {
    const tId = await turmaDaAvaliacao(req.params.id);
    if (!tId) return res.status(404).json({ erro: 'Avaliação não encontrada.' });
    if (!await podeTurma(req, tId)) return res.status(403).json({ erro: 'Avaliação de turma não vinculada ao seu cadastro.' });
    await pool.query(`DELETE FROM avaliacoes WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('Erro DELETE avaliacao:', e); res.status(500).json({ erro: 'Erro ao remover a avaliação.' }); }
});

app.get('/professor/avaliacoes/:id/notas', autenticar, somenteProfessor, async (req, res) => {
  try {
    const tId = await turmaDaAvaliacao(req.params.id);
    if (!tId) return res.status(404).json({ erro: 'Avaliação não encontrada.' });
    if (!await podeTurma(req, tId)) return res.status(403).json({ erro: 'Avaliação de turma não vinculada ao seu cadastro.' });
    const r = await pool.query(
      `SELECT m.id AS matricula_id, a.nome, n.nota
       FROM matriculas m
       JOIN alunos a ON a.id = m.aluno_id
       LEFT JOIN notas n ON n.matricula_id = m.id AND n.avaliacao_id = $2
       WHERE m.turma_id = $1 AND m.status = 'ativa'
       ORDER BY a.nome`, [tId, req.params.id]);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET notas:', e); res.status(500).json({ erro: 'Erro ao carregar as notas.' }); }
});

app.post('/professor/avaliacoes/:id/notas', autenticar, somenteProfessor, async (req, res) => {
  const client = await pool.connect();
  try {
    const tId = await turmaDaAvaliacao(req.params.id);
    if (!tId) { client.release(); return res.status(404).json({ erro: 'Avaliação não encontrada.' }); }
    if (!await podeTurma(req, tId)) { client.release(); return res.status(403).json({ erro: 'Avaliação de turma não vinculada ao seu cadastro.' }); }
    const lista = Array.isArray(req.body.notas) ? req.body.notas : [];
    await client.query('BEGIN');
    for (const item of lista) {
      const mId = Number(item.matricula_id);
      if (item.nota === '' || item.nota === null || item.nota === undefined) {
        await client.query(`DELETE FROM notas WHERE avaliacao_id = $1 AND matricula_id = $2`, [req.params.id, mId]);
        continue;
      }
      const valor = Number(item.nota);
      if (!(valor >= 0 && valor <= 10)) { await client.query('ROLLBACK'); client.release(); return res.status(400).json({ erro: 'As notas devem estar entre 0 e 10.' }); }
      await client.query(
        `INSERT INTO notas (avaliacao_id, matricula_id, nota, lancada_por)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (avaliacao_id, matricula_id)
         DO UPDATE SET nota = EXCLUDED.nota, lancada_por = EXCLUDED.lancada_por, lancada_em = NOW()`,
        [req.params.id, mId, valor, req.usuario.id]);
    }
    await client.query('COMMIT'); client.release();
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); client.release();
    console.error('Erro POST notas:', e); res.status(500).json({ erro: 'Erro ao salvar as notas.' });
  }
});

// --- Avisos do professor (turma ou aluno) ---
app.post('/professor/avisos', autenticar, somenteProfessor, async (req, res) => {
  try {
    const escopo = req.body.escopo === 'aluno' ? 'aluno' : 'turma';
    const titulo = (req.body.titulo || '').trim();
    const mensagem = (req.body.mensagem || '').trim();
    if (!titulo || !mensagem) return res.status(400).json({ erro: 'Informe o título e a mensagem.' });
    const turmaId = Number(req.body.turma_id) || null;
    if (!turmaId) return res.status(400).json({ erro: 'Selecione a turma.' });
    if (!await podeTurma(req, turmaId)) return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' });
    const alunoId = escopo === 'aluno' ? (Number(req.body.aluno_id) || null) : null;
    if (escopo === 'aluno' && !alunoId) return res.status(400).json({ erro: 'Selecione o aluno.' });
    const r = await pool.query(
      `INSERT INTO avisos (autor_id, escopo, turma_id, aluno_id, titulo, mensagem)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.usuario.id, escopo, turmaId, alunoId, titulo, mensagem]);
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) { console.error('Erro POST aviso professor:', e); res.status(500).json({ erro: 'Erro ao publicar o aviso.' }); }
});

app.get('/professor/avisos', autenticar, somenteProfessor, async (req, res) => {
  try {
    const turmaId = Number(req.query.turma_id) || null;
    if (!turmaId) return res.status(400).json({ erro: 'Selecione a turma.' });
    if (!await podeTurma(req, turmaId)) return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' });
    const r = await pool.query(
      `SELECT av.id, av.escopo, av.titulo, av.mensagem, av.criado_em, a.nome AS aluno_nome
       FROM avisos av LEFT JOIN alunos a ON a.id = av.aluno_id
       WHERE av.turma_id = $1 ORDER BY av.criado_em DESC`, [turmaId]);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET avisos professor:', e); res.status(500).json({ erro: 'Erro ao listar os avisos.' }); }
});

app.delete('/professor/avisos/:id', autenticar, somenteProfessor, async (req, res) => {
  try {
    const a = await pool.query(`SELECT turma_id FROM avisos WHERE id = $1`, [req.params.id]);
    if (!a.rows.length) return res.status(404).json({ erro: 'Aviso não encontrado.' });
    if (a.rows[0].turma_id && !await podeTurma(req, a.rows[0].turma_id)) return res.status(403).json({ erro: 'Aviso de turma não vinculada ao seu cadastro.' });
    await pool.query(`DELETE FROM avisos WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('Erro DELETE aviso professor:', e); res.status(500).json({ erro: 'Erro ao remover o aviso.' }); }
});

// --- Ocorrências por aluno ---
app.get('/professor/ocorrencias', autenticar, somenteProfessor, async (req, res) => {
  try {
    const cond = [], params = [];
    if (req.query.turma_id) {
      if (!await podeTurma(req, req.query.turma_id)) return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' });
      params.push(Number(req.query.turma_id)); cond.push(`o.turma_id = $${params.length}`);
    } else {
      const prof = escopoProfessor(req);
      if (prof !== null) { params.push(prof); cond.push(`o.professor_id = $${params.length}`); }
    }
    if (req.query.aluno_id) { params.push(Number(req.query.aluno_id)); cond.push(`o.aluno_id = $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await pool.query(
      `SELECT o.id, o.data, o.tipo, o.titulo, o.descricao, o.visivel_responsavel,
              a.nome AS aluno_nome, t.nome AS turma_nome
       FROM ocorrencias o
       JOIN alunos a ON a.id = o.aluno_id
       LEFT JOIN turmas t ON t.id = o.turma_id
       ${where} ORDER BY o.data DESC, o.id DESC`, params);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET ocorrencias:', e); res.status(500).json({ erro: 'Erro ao listar as ocorrências.' }); }
});

app.post('/professor/ocorrencias', autenticar, somenteProfessor, async (req, res) => {
  try {
    const alunoId = Number(req.body.aluno_id);
    const turmaId = Number(req.body.turma_id) || null;
    const titulo = (req.body.titulo || '').trim();
    const descricao = (req.body.descricao || '').trim();
    if (!alunoId) return res.status(400).json({ erro: 'Selecione o aluno.' });
    if (!titulo || !descricao) return res.status(400).json({ erro: 'Informe o título e a descrição.' });
    if (turmaId && !await podeTurma(req, turmaId)) return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' });
    const tipos = ['comportamento','pedagogica','elogio','saude','outro'];
    const tipo = tipos.includes(req.body.tipo) ? req.body.tipo : 'pedagogica';
    const r = await pool.query(
      `INSERT INTO ocorrencias (aluno_id, turma_id, professor_id, data, tipo, titulo, descricao, visivel_responsavel)
       VALUES ($1,$2,$3,COALESCE($4, CURRENT_DATE),$5,$6,$7,$8) RETURNING id`,
      [alunoId, turmaId, escopoProfessor(req), req.body.data || null, tipo, titulo, descricao,
       req.body.visivel_responsavel !== false]);
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) { console.error('Erro POST ocorrencia:', e); res.status(500).json({ erro: 'Erro ao registrar a ocorrência.' }); }
});

app.delete('/professor/ocorrencias/:id', autenticar, somenteProfessor, async (req, res) => {
  try {
    const o = await pool.query(`SELECT turma_id FROM ocorrencias WHERE id = $1`, [req.params.id]);
    if (!o.rows.length) return res.status(404).json({ erro: 'Ocorrência não encontrada.' });
    if (o.rows[0].turma_id && !await podeTurma(req, o.rows[0].turma_id)) return res.status(403).json({ erro: 'Ocorrência de turma não vinculada ao seu cadastro.' });
    await pool.query(`DELETE FROM ocorrencias WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('Erro DELETE ocorrencia:', e); res.status(500).json({ erro: 'Erro ao remover a ocorrência.' }); }
});

// --- Atividades para casa (link + arquivos) ---
app.get('/professor/turmas/:id/atividades', autenticar, somenteProfessor, async (req, res) => {
  try {
    if (!await podeTurma(req, req.params.id)) return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' });
    const r = await pool.query(
      `SELECT at.id, at.titulo, at.descricao, at.link, at.data_entrega, at.criado_em,
              COALESCE(json_agg(json_build_object('id', ar.id, 'nome', ar.nome, 'mime', ar.mime, 'tamanho', ar.tamanho)
                       ORDER BY ar.id) FILTER (WHERE ar.id IS NOT NULL), '[]') AS arquivos
       FROM atividades at
       LEFT JOIN atividade_arquivos ar ON ar.atividade_id = at.id
       WHERE at.turma_id = $1
       GROUP BY at.id ORDER BY at.criado_em DESC`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET atividades:', e); res.status(500).json({ erro: 'Erro ao listar as atividades.' }); }
});

app.post('/professor/turmas/:id/atividades', autenticar, somenteProfessor, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!await podeTurma(req, req.params.id)) { client.release(); return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' }); }
    const titulo = (req.body.titulo || '').trim();
    if (!titulo) { client.release(); return res.status(400).json({ erro: 'Informe o título da atividade.' }); }
    const arquivos = Array.isArray(req.body.arquivos) ? req.body.arquivos : [];
    for (const f of arquivos) {
      if (!MIMES_OK[f.mime]) { client.release(); return res.status(400).json({ erro: `Formato não permitido: ${f.nome || f.mime}. Aceitos: foto, PDF e Word.` }); }
      const bytes = Buffer.byteLength(String(f.base64 || ''), 'base64');
      if (bytes > LIMITE_ARQUIVO) { client.release(); return res.status(400).json({ erro: `O arquivo ${f.nome} passa de 5 MB.` }); }
    }
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO atividades (turma_id, professor_id, titulo, descricao, link, data_entrega)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.params.id, escopoProfessor(req), titulo, (req.body.descricao || '').trim() || null,
       (req.body.link || '').trim() || null, req.body.data_entrega || null]);
    const atId = r.rows[0].id;
    for (const f of arquivos) {
      const buf = Buffer.from(String(f.base64 || ''), 'base64');
      await client.query(
        `INSERT INTO atividade_arquivos (atividade_id, nome, mime, tamanho, conteudo) VALUES ($1,$2,$3,$4,$5)`,
        [atId, (f.nome || 'arquivo').slice(0, 180), f.mime, buf.length, buf]);
    }
    await client.query('COMMIT'); client.release();
    res.status(201).json({ id: atId, arquivos: arquivos.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); client.release();
    console.error('Erro POST atividade:', e); res.status(500).json({ erro: 'Erro ao publicar a atividade.' });
  }
});

app.delete('/professor/atividades/:id', autenticar, somenteProfessor, async (req, res) => {
  try {
    const a = await pool.query(`SELECT turma_id FROM atividades WHERE id = $1`, [req.params.id]);
    if (!a.rows.length) return res.status(404).json({ erro: 'Atividade não encontrada.' });
    if (!await podeTurma(req, a.rows[0].turma_id)) return res.status(403).json({ erro: 'Atividade de turma não vinculada ao seu cadastro.' });
    await pool.query(`DELETE FROM atividades WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error('Erro DELETE atividade:', e); res.status(500).json({ erro: 'Erro ao remover a atividade.' }); }
});

// Download de anexo (aceita token de professor/gestão ou de responsável, via header ou ?token=)
app.get('/arquivos/atividade/:id', async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = req.query.token || (header.startsWith('Bearer ') ? header.slice(7) : null);
    if (!token) return res.status(401).json({ erro: 'Token não fornecido.' });
    try { jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ erro: 'Token inválido ou expirado.' }); }
    const r = await pool.query(`SELECT nome, mime, conteudo FROM atividade_arquivos WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
    const f = r.rows[0];
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.nome)}`);
    res.send(f.conteudo);
  } catch (e) { console.error('Erro download anexo:', e); res.status(500).json({ erro: 'Erro ao baixar o arquivo.' }); }
});

// ---------- Declaração de Estudos (somente Gestão) ----------
app.post('/admin/declaracoes/estudos', autenticar, somenteGestao, async (req, res) => {
  try {
    const alunoId = Number(req.body.aluno_id);
    if (!alunoId) return res.status(400).json({ erro: 'Selecione o aluno.' });
    const modulos = Array.isArray(req.body.modulos)
      ? req.body.modulos.map(m => String(m || '').trim()).filter(Boolean)
      : [];
    if (!modulos.length) return res.status(400).json({ erro: 'Informe ao menos um módulo cursado.' });
    const a = await pool.query(`SELECT id, nome, cpf FROM alunos WHERE id = $1`, [alunoId]);
    if (!a.rows.length) return res.status(404).json({ erro: 'Aluno não encontrado.' });
    const aluno = a.rows[0];
    // 1 módulo = 1 semestre letivo = 60 horas-aula
    const HORAS_POR_MODULO = 60;
    const totalSemestres = modulos.length;
    const cargaHoraria = totalSemestres * HORAS_POR_MODULO;
    const curso = (req.body.curso || 'Língua e Cultura Inglesa').trim();
    let codigo, ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      codigo = 'CEMIC-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
      const ex = await pool.query(`SELECT 1 FROM declaracoes WHERE codigo = $1`, [codigo]);
      if (!ex.rows.length) ok = true;
    }
    const ins = await pool.query(
      `INSERT INTO declaracoes (codigo, tipo, aluno_id, aluno_nome, aluno_cpf, curso, modulos, total_semestres, carga_horaria, emitida_por)
       VALUES ($1, 'estudos', $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       RETURNING codigo, emitida_em`,
      [codigo, alunoId, aluno.nome, aluno.cpf, curso, JSON.stringify(modulos), totalSemestres, cargaHoraria, req.usuario.id]);
    res.status(201).json({
      codigo: ins.rows[0].codigo, emitida_em: ins.rows[0].emitida_em,
      aluno_nome: aluno.nome, aluno_cpf: aluno.cpf, curso,
      modulos, total_semestres: totalSemestres, carga_horaria: cargaHoraria, horas_por_modulo: HORAS_POR_MODULO
    });
  } catch (e) { console.error('Erro declaração de estudos:', e); res.status(500).json({ erro: 'Erro ao emitir a declaração.' }); }
});

// ---------- Portal dos Pais: acadêmico (professor -> responsável) ----------
async function vinculoOk(respId, alunoId) {
  const r = await pool.query(`SELECT 1 FROM aluno_responsavel WHERE responsavel_id = $1 AND aluno_id = $2`, [respId, alunoId]);
  return r.rows.length > 0;
}
async function matriculaAtivaDoAluno(alunoId) {
  const r = await pool.query(
    `SELECT m.id AS matricula_id, m.turma_id, t.nome AS turma_nome, t.semestre
     FROM matriculas m JOIN turmas t ON t.id = m.turma_id
     WHERE m.aluno_id = $1 AND m.status = 'ativa'
     ORDER BY m.id DESC LIMIT 1`, [alunoId]);
  return r.rows[0] || null;
}

app.get('/publico/portal/aluno/:id/faltas', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    if (!await vinculoOk(req.responsavelId, alunoId)) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const mat = await matriculaAtivaDoAluno(alunoId);
    if (!mat) return res.json({ turma: null, itens: [], resumo: { aulas: 0, presencas: 0, faltas: 0, percentual: null } });
    const r = await pool.query(
      `SELECT au.id, au.data, au.conteudo, f.presente, f.justificativa
       FROM aulas au
       LEFT JOIN frequencias f ON f.aula_id = au.id AND f.matricula_id = $2
       WHERE au.turma_id = $1
       ORDER BY au.data DESC, au.id DESC`, [mat.turma_id, mat.matricula_id]);
    const lancadas = r.rows.filter(x => x.presente !== null);
    const faltas = lancadas.filter(x => x.presente === false).length;
    const presencas = lancadas.length - faltas;
    const percentual = lancadas.length ? Math.round((presencas / lancadas.length) * 100) : null;
    res.json({
      turma: mat.turma_nome, semestre: mat.semestre,
      itens: r.rows.filter(x => x.presente !== null),
      resumo: { aulas: lancadas.length, presencas, faltas, percentual }
    });
  } catch (e) { console.error('Erro portal faltas:', e); res.status(500).json({ erro: 'Erro ao carregar a frequência.' }); }
});

app.get('/publico/portal/aluno/:id/conteudos', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    if (!await vinculoOk(req.responsavelId, alunoId)) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const mat = await matriculaAtivaDoAluno(alunoId);
    if (!mat) return res.json({ turma: null, itens: [] });
    const r = await pool.query(
      `SELECT au.id, au.data, au.conteudo FROM aulas au
       WHERE au.turma_id = $1 AND au.conteudo IS NOT NULL AND btrim(au.conteudo) <> ''
       ORDER BY au.data DESC, au.id DESC`, [mat.turma_id]);
    res.json({ turma: mat.turma_nome, semestre: mat.semestre, itens: r.rows });
  } catch (e) { console.error('Erro portal conteudos:', e); res.status(500).json({ erro: 'Erro ao carregar os conteúdos.' }); }
});

app.get('/publico/portal/aluno/:id/notas', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    if (!await vinculoOk(req.responsavelId, alunoId)) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const mat = await matriculaAtivaDoAluno(alunoId);
    if (!mat) return res.json({ turma: null, itens: [], media: null });
    const r = await pool.query(
      `SELECT av.id, av.nome, av.peso, av.data, n.nota
       FROM avaliacoes av
       LEFT JOIN notas n ON n.avaliacao_id = av.id AND n.matricula_id = $2
       WHERE av.turma_id = $1
       ORDER BY av.data NULLS LAST, av.id`, [mat.turma_id, mat.matricula_id]);
    const comNota = r.rows.filter(x => x.nota !== null);
    let media = null;
    if (comNota.length) {
      const somaPeso = comNota.reduce((s, x) => s + Number(x.peso || 1), 0);
      const soma = comNota.reduce((s, x) => s + Number(x.nota) * Number(x.peso || 1), 0);
      media = somaPeso > 0 ? Number((soma / somaPeso).toFixed(2)) : null;
    }
    res.json({ turma: mat.turma_nome, semestre: mat.semestre, itens: r.rows, media });
  } catch (e) { console.error('Erro portal notas:', e); res.status(500).json({ erro: 'Erro ao carregar as notas.' }); }
});

app.get('/publico/portal/aluno/:id/ocorrencias', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    if (!await vinculoOk(req.responsavelId, alunoId)) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const r = await pool.query(
      `SELECT o.id, o.data, o.tipo, o.titulo, o.descricao, p.nome AS professor_nome, t.nome AS turma_nome
       FROM ocorrencias o
       LEFT JOIN professores p ON p.id = o.professor_id
       LEFT JOIN turmas t ON t.id = o.turma_id
       WHERE o.aluno_id = $1 AND o.visivel_responsavel = TRUE
       ORDER BY o.data DESC, o.id DESC`, [alunoId]);
    res.json(r.rows);
  } catch (e) { console.error('Erro portal ocorrencias:', e); res.status(500).json({ erro: 'Erro ao carregar as ocorrências.' }); }
});

app.get('/publico/portal/aluno/:id/atividades', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    if (!await vinculoOk(req.responsavelId, alunoId)) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const mat = await matriculaAtivaDoAluno(alunoId);
    if (!mat) return res.json({ turma: null, itens: [] });
    const r = await pool.query(
      `SELECT at.id, at.titulo, at.descricao, at.link, at.data_entrega, at.criado_em,
              COALESCE(json_agg(json_build_object('id', ar.id, 'nome', ar.nome, 'mime', ar.mime, 'tamanho', ar.tamanho)
                       ORDER BY ar.id) FILTER (WHERE ar.id IS NOT NULL), '[]') AS arquivos
       FROM atividades at
       LEFT JOIN atividade_arquivos ar ON ar.atividade_id = at.id
       WHERE at.turma_id = $1
       GROUP BY at.id ORDER BY at.criado_em DESC`, [mat.turma_id]);
    res.json({ turma: mat.turma_nome, semestre: mat.semestre, itens: r.rows });
  } catch (e) { console.error('Erro portal atividades:', e); res.status(500).json({ erro: 'Erro ao carregar as atividades.' }); }
});

// ---------- Portal: Financeiro do aluno ----------
const SQL_FIN_ITENS = `
  SELECT cr.id, cr.descricao, cr.competencia, cr.vencimento,
         cr.status, cr.data_pagamento, cr.forma_pagamento, t.semestre,
         cr.valor_final AS valor_cobrado,
         COALESCE(cr.desconto_pontualidade, 0) AS desconto,
         COALESCE(cr.juros, 0) AS juros,
         CASE WHEN cr.status = 'paga'
              THEN COALESCE(cr.valor_recebido, cr.valor_final - COALESCE(cr.desconto_pontualidade,0) + COALESCE(cr.juros,0))
         END AS valor_pago,
         CASE WHEN cr.status = 'paga'
              THEN COALESCE(cr.valor_recebido, cr.valor_final - COALESCE(cr.desconto_pontualidade,0) + COALESCE(cr.juros,0))
              ELSE cr.valor_final
         END AS valor,
         CASE
           WHEN cr.status = 'paga' THEN 'pago'
           WHEN cr.vencimento < CURRENT_DATE THEN 'vencido'
           ELSE 'em_aberto'
         END AS situacao,
         CASE
           WHEN cr.descricao ILIKE 'Taxa de Matrícula%' THEN 'matricula'
           WHEN cr.descricao ILIKE 'Taxa da Plataforma%' THEN 'plataforma'
           ELSE 'mensalidade'
         END AS tipo
  FROM contas_receber cr
  JOIN matriculas m ON m.id = cr.matricula_id
  JOIN turmas t ON t.id = m.turma_id
  WHERE cr.aluno_id = $1 AND t.semestre = $2 AND cr.status <> 'cancelada'
  ORDER BY cr.vencimento, cr.id`;

function resumoFinanceiro(itens) {
  const n = x => Number(x || 0);
  // 'valor' = o que foi realmente pago (nos quitados) ou o que está sendo cobrado (nos demais)
  const total = itens.reduce((s, i) => s + n(i.valor), 0);
  const pago = itens.filter(i => i.situacao === 'pago').reduce((s, i) => s + n(i.valor), 0);
  const vencido = itens.filter(i => i.situacao === 'vencido').reduce((s, i) => s + n(i.valor), 0);
  const aberto = itens.filter(i => i.situacao === 'em_aberto').reduce((s, i) => s + n(i.valor), 0);
  const pendentes = itens.filter(i => i.situacao !== 'pago').length;
  return { total, pago, aberto, vencido, pendentes, quitado: itens.length > 0 && pendentes === 0 };
}

app.get('/publico/portal/aluno/:id/financeiro', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    const vinc = await pool.query(`SELECT 1 FROM aluno_responsavel WHERE responsavel_id = $1 AND aluno_id = $2`, [req.responsavelId, alunoId]);
    if (!vinc.rows.length) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const sems = await pool.query(
      `SELECT DISTINCT t.semestre FROM matriculas m
       JOIN turmas t ON t.id = m.turma_id
       WHERE m.aluno_id = $1 AND t.semestre IS NOT NULL
       ORDER BY t.semestre DESC`, [alunoId]);
    const semestres = sems.rows.map(r => r.semestre);
    let semestre = (req.query.semestre || '').trim();
    if (!semestre) {
      const vig = await getConfig('semestre_vigente', null);
      semestre = (vig && semestres.includes(vig)) ? vig : (semestres[0] || null);
    }
    if (!semestre) return res.json({ semestre: null, semestres: [], itens: [], resumo: resumoFinanceiro([]) });
    const r = await pool.query(SQL_FIN_ITENS, [alunoId, semestre]);
    res.json({ semestre, semestres, itens: r.rows, resumo: resumoFinanceiro(r.rows) });
  } catch (e) { console.error('Erro portal financeiro:', e); res.status(500).json({ erro: 'Erro ao carregar o financeiro.' }); }
});

app.post('/publico/portal/aluno/:id/relatorio-financeiro', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    const semestre = String(req.body.semestre || '').trim();
    if (!semestre) return res.status(400).json({ erro: 'Informe o semestre.' });
    const vinc = await pool.query(`SELECT 1 FROM aluno_responsavel WHERE responsavel_id = $1 AND aluno_id = $2`, [req.responsavelId, alunoId]);
    if (!vinc.rows.length) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const it = await pool.query(SQL_FIN_ITENS, [alunoId, semestre]);
    const itens = it.rows;
    if (!itens.length) return res.status(404).json({ erro: 'Não há lançamentos financeiros neste semestre.' });
    const resumo = resumoFinanceiro(itens);
    if (!resumo.quitado) {
      return res.status(409).json({
        erro: 'O relatório só pode ser emitido quando todos os pagamentos do semestre estiverem quitados.',
        pendentes: resumo.pendentes
      });
    }
    const dr = await pool.query(
      `SELECT a.nome, a.cpf, t.turno, n.nome AS nivel_nome
       FROM alunos a
       LEFT JOIN matriculas m ON m.aluno_id = a.id
       LEFT JOIN turmas t ON t.id = m.turma_id AND t.semestre = $2
       LEFT JOIN niveis n ON n.id = t.nivel_id
       WHERE a.id = $1
       ORDER BY (t.semestre = $2) DESC NULLS LAST
       LIMIT 1`, [alunoId, semestre]);
    const d = dr.rows[0];
    if (!d) return res.status(404).json({ erro: 'Aluno não encontrado.' });
    const curso = 'Língua e Cultura Inglesa';
    let codigo, ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      codigo = 'CEMIC-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
      const ex = await pool.query(`SELECT 1 FROM declaracoes WHERE codigo = $1`, [codigo]);
      if (!ex.rows.length) ok = true;
    }
    const ins = await pool.query(
      `INSERT INTO declaracoes (codigo, tipo, aluno_id, aluno_nome, aluno_cpf, curso, modulo, turno, semestre, responsavel_id)
       VALUES ($1, 'financeiro', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING codigo, emitida_em`,
      [codigo, alunoId, d.nome, d.cpf, curso, d.nivel_nome || null, d.turno || null, semestre, req.responsavelId]);
    res.status(201).json({
      codigo: ins.rows[0].codigo, emitida_em: ins.rows[0].emitida_em,
      aluno_nome: d.nome, aluno_cpf: d.cpf, curso, modulo: d.nivel_nome || null, turno: d.turno || null,
      semestre, itens, resumo
    });
  } catch (e) { console.error('Erro relatório financeiro:', e); res.status(500).json({ erro: 'Erro ao gerar o relatório financeiro.' }); }
});

app.get('/publico/verificar/:codigo', async (req, res) => {
  try {
    const codigo = String(req.params.codigo || '').trim().toUpperCase();
    const r = await pool.query(
      `SELECT codigo, tipo, aluno_nome, aluno_cpf, curso, modulo, turno, semestre, modulos, total_semestres, carga_horaria, emitida_em FROM declaracoes WHERE codigo = $1`, [codigo]);
    if (!r.rows.length) {
      // Pode ser uma carteira estudantil
      const c = await pool.query(
        `SELECT codigo, aluno_nome, aluno_cpf, aluno_codigo, curso, modulo, turma_nome, turno, semestre, validade, emitida_em FROM carteiras WHERE codigo = $1`, [codigo]);
      if (!c.rows.length) return res.status(404).json({ valido: false, erro: 'Documento não encontrado. Verifique o código.' });
      const k = c.rows[0];
      const vencida = k.validade ? (new Date(k.validade) < new Date(new Date().toDateString())) : false;
      const cpfK = (k.aluno_cpf || '').replace(/\D/g, '');
      const cpfKMasc = cpfK.length === 11 ? `${cpfK.slice(0, 3)}.***.***-${cpfK.slice(9)}` : null;
      return res.json({
        valido: true, codigo: k.codigo, tipo: 'carteira', aluno_nome: k.aluno_nome, aluno_cpf: cpfKMasc, aluno_codigo: k.aluno_codigo,
        curso: k.curso, modulo: k.modulo, turma_nome: k.turma_nome, turno: k.turno, semestre: k.semestre,
        validade: k.validade, situacao: vencida ? 'expirada' : 'vigente', emitida_em: k.emitida_em
      });
    }
    const d = r.rows[0];
    const cpf = (d.aluno_cpf || '').replace(/\D/g, '');
    const cpfMasc = cpf.length === 11 ? `${cpf.slice(0, 3)}.***.***-${cpf.slice(9)}` : null;
    res.json({ valido: true, codigo: d.codigo, tipo: d.tipo, aluno_nome: d.aluno_nome, aluno_cpf: cpfMasc, curso: d.curso, modulo: d.modulo, turno: d.turno, semestre: d.semestre, modulos: d.modulos, total_semestres: d.total_semestres, carga_horaria: d.carga_horaria, emitida_em: d.emitida_em });
  } catch (e) { console.error('Erro verificar declaração:', e); res.status(500).json({ valido: false, erro: 'Erro ao verificar o documento.' }); }
});

// ============================================================
// CARTEIRA ESTUDANTIL — foto do aluno + emissão (Portal dos Pais)
// ============================================================
const FOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const FOTO_MAX_BYTES = 2 * 1024 * 1024;

// A carteira vale enquanto o semestre letivo estiver em curso.
function fimDoSemestre(sem) {
  const m = String(sem || '').match(/^(\d{4})\.([12])$/);
  if (!m) return null;
  return m[2] === '1' ? `${m[1]}-06-30` : `${m[1]}-12-31`;
}

function fotoDoCorpo(body) {
  const mime = String((body && body.mime) || '').toLowerCase().trim();
  if (!FOTO_MIMES.includes(mime)) return { erro: 'Envie a foto em JPG, PNG ou WEBP.' };
  const base64 = String((body && body.base64) || '').replace(/^data:[^,]*,/, '').trim();
  if (!base64) return { erro: 'Nenhuma imagem foi recebida.' };
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) return { erro: 'Imagem inválida.' };
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) return { erro: 'Imagem inválida.' };
  if (buf.length > FOTO_MAX_BYTES) return { erro: 'A foto deve ter no máximo 2 MB.' };
  return { mime, buf };
}

// Envio da foto pelo responsável (uma foto por aluno; novo envio substitui a anterior)
app.post('/publico/portal/aluno/:id/foto', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    if (!(await vinculoOk(req.responsavelId, alunoId))) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const f = fotoDoCorpo(req.body);
    if (f.erro) return res.status(400).json({ erro: f.erro });
    await pool.query(
      `INSERT INTO aluno_fotos (aluno_id, mime, tamanho, conteudo, enviada_por, enviada_em)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (aluno_id) DO UPDATE
         SET mime = EXCLUDED.mime, tamanho = EXCLUDED.tamanho, conteudo = EXCLUDED.conteudo,
             enviada_por = EXCLUDED.enviada_por, enviada_em = NOW()`,
      [alunoId, f.mime, f.buf.length, f.buf, req.responsavelId]);
    res.status(201).json({ ok: true, tamanho: f.buf.length });
  } catch (e) { console.error('Erro enviar foto do aluno:', e); res.status(500).json({ erro: 'Erro ao enviar a foto.' }); }
});

app.delete('/publico/portal/aluno/:id/foto', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    if (!(await vinculoOk(req.responsavelId, alunoId))) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    await pool.query(`DELETE FROM aluno_fotos WHERE aluno_id = $1`, [alunoId]);
    res.json({ ok: true });
  } catch (e) { console.error('Erro remover foto do aluno:', e); res.status(500).json({ erro: 'Erro ao remover a foto.' }); }
});

// A Gestão pode remover uma foto inadequada
app.delete('/admin/alunos/:id/foto', autenticar, somenteGestao, async (req, res) => {
  try {
    await pool.query(`DELETE FROM aluno_fotos WHERE aluno_id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { console.error('Erro remover foto (gestão):', e); res.status(500).json({ erro: 'Erro ao remover a foto.' }); }
});

// Entrega da foto: só o responsável vinculado ou a gestão; nunca uma URL pública
app.get('/arquivos/aluno-foto/:id', async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = req.query.token || (header.startsWith('Bearer ') ? header.slice(7) : null);
    if (!token) return res.status(401).json({ erro: 'Token não fornecido.' });
    let dados;
    try { dados = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).json({ erro: 'Token inválido ou expirado.' }); }
    const alunoId = Number(req.params.id);
    if (dados.perfil === 'responsavel') {
      if (!(await vinculoOk(dados.responsavel_id, alunoId))) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    } else if (!['master', 'secretaria'].includes(dados.perfil)) {
      return res.status(403).json({ erro: 'Acesso negado.' });
    }
    const r = await pool.query(`SELECT mime, conteudo FROM aluno_fotos WHERE aluno_id = $1`, [alunoId]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Foto não encontrada.' });
    res.setHeader('Content-Type', r.rows[0].mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(r.rows[0].conteudo);
  } catch (e) { console.error('Erro baixar foto do aluno:', e); res.status(500).json({ erro: 'Erro ao carregar a foto.' }); }
});

// Emissão da carteira: uma por aluno e semestre (reemitir devolve a mesma)
app.post('/publico/portal/aluno/:id/carteira', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    if (!(await vinculoOk(req.responsavelId, alunoId))) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const dr = await pool.query(
      `SELECT a.nome, a.cpf AS aluno_cpf, a.codigo AS aluno_codigo, t.nome AS turma_nome, t.turno, t.semestre,
              n.nome AS nivel_nome, c.nome AS curso_nome
       FROM alunos a
       LEFT JOIN matriculas m ON m.aluno_id = a.id AND m.status = 'ativa'
       LEFT JOIN turmas t ON t.id = m.turma_id
       LEFT JOIN niveis n ON n.id = t.nivel_id
       LEFT JOIN cursos c ON c.id = n.curso_id
       WHERE a.id = $1
       ORDER BY m.id DESC LIMIT 1`, [alunoId]);
    const d = dr.rows[0];
    if (!d) return res.status(404).json({ erro: 'Aluno não encontrado.' });
    if (!d.semestre) return res.status(400).json({ erro: 'A carteira só pode ser emitida com uma matrícula ativa. Procure a secretaria.' });

    const semestre = d.semestre;
    const validade = fimDoSemestre(semestre);
    const curso = d.curso_nome || 'Inglês';

    const existente = await pool.query(`SELECT codigo, emitida_em FROM carteiras WHERE aluno_id = $1 AND semestre = $2`, [alunoId, semestre]);
    let codigo, emitidaEm;
    if (existente.rows.length) {
      codigo = existente.rows[0].codigo;
      emitidaEm = existente.rows[0].emitida_em;
      await pool.query(
        `UPDATE carteiras SET aluno_nome = $1, aluno_cpf = $2, aluno_codigo = $3, curso = $4, modulo = $5, turma_nome = $6, turno = $7, validade = $8
         WHERE codigo = $9`,
        [d.nome, d.aluno_cpf, d.aluno_codigo, curso, d.nivel_nome || null, d.turma_nome || null, d.turno || null, validade, codigo]);
    } else {
      let ok = false;
      for (let i = 0; i < 6 && !ok; i++) {
        codigo = 'CEMIC-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
        const ex = await pool.query(`SELECT 1 FROM declaracoes WHERE codigo = $1 UNION ALL SELECT 1 FROM carteiras WHERE codigo = $1`, [codigo]);
        if (!ex.rows.length) ok = true;
      }
      const ins = await pool.query(
        `INSERT INTO carteiras (codigo, aluno_id, aluno_nome, aluno_cpf, aluno_codigo, curso, modulo, turma_nome, turno, semestre, validade, emitida_por_responsavel)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING emitida_em`,
        [codigo, alunoId, d.nome, d.aluno_cpf, d.aluno_codigo, curso, d.nivel_nome || null, d.turma_nome || null, d.turno || null, semestre, validade, req.responsavelId]);
      emitidaEm = ins.rows[0].emitida_em;
    }

    const foto = await pool.query(`SELECT 1 FROM aluno_fotos WHERE aluno_id = $1`, [alunoId]);
    res.status(201).json({
      codigo, emitida_em: emitidaEm, aluno_nome: d.nome, aluno_cpf: d.aluno_cpf, aluno_codigo: d.aluno_codigo,
      curso, modulo: d.nivel_nome || null, turma_nome: d.turma_nome || null, turno: d.turno || null,
      semestre, validade, tem_foto: foto.rows.length > 0
    });
  } catch (e) { console.error('Erro emitir carteira:', e); res.status(500).json({ erro: 'Erro ao emitir a carteira.' }); }
});

// Situação da carteira e da foto, para montar a tela sem emitir nada
app.get('/publico/portal/aluno/:id/carteira', autenticarResponsavel, async (req, res) => {
  try {
    const alunoId = Number(req.params.id);
    if (!(await vinculoOk(req.responsavelId, alunoId))) return res.status(403).json({ erro: 'Acesso negado a este aluno.' });
    const foto = await pool.query(`SELECT tamanho, enviada_em FROM aluno_fotos WHERE aluno_id = $1`, [alunoId]);
    const mat = await matriculaAtivaDoAluno(alunoId);
    const cart = mat ? await pool.query(`SELECT codigo, emitida_em, validade FROM carteiras WHERE aluno_id = $1 AND semestre = $2`, [alunoId, mat.semestre]) : { rows: [] };
    res.json({
      tem_foto: foto.rows.length > 0,
      foto_enviada_em: foto.rows.length ? foto.rows[0].enviada_em : null,
      semestre: mat ? mat.semestre : null,
      emitida: cart.rows.length > 0,
      codigo: cart.rows.length ? cart.rows[0].codigo : null,
      validade: cart.rows.length ? cart.rows[0].validade : null
    });
  } catch (e) { console.error('Erro consultar carteira:', e); res.status(500).json({ erro: 'Erro ao carregar a carteira.' }); }
});

// ============================================================
// CALENDÁRIO ACADÊMICO
// ============================================================
const MESES_PT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// Agrupa os eventos por mês, na ordem do calendário
function calendarioPorMes(linhas) {
  const meses = [];
  for (const ev of linhas) {
    const d = new Date(ev.data);
    const chave = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    let mes = meses.find(m => m.chave === chave);
    if (!mes) {
      mes = { chave, ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, nome: MESES_PT[d.getUTCMonth()], eventos: [] };
      meses.push(mes);
    }
    mes.eventos.push({ id: ev.id, data: ev.data, dia: d.getUTCDate(), titulo: ev.titulo, detalhe: ev.detalhe, modalidade: ev.modalidade });
  }
  return meses;
}

async function montarCalendario(semestre) {
  const sem = semestre || await getConfig('semestre_vigente', '2026.2');
  const r = await pool.query(
    `SELECT id, data, titulo, detalhe, modalidade FROM calendario WHERE semestre = $1 ORDER BY data, id`, [sem]);
  const obs = await getConfig('calendario_observacao', '');
  return { semestre: sem, observacao: obs, meses: calendarioPorMes(r.rows) };
}

app.get('/calendario', autenticar, async (req, res) => {
  try { res.json(await montarCalendario(req.query.semestre)); }
  catch (e) { console.error('Erro GET calendario:', e); res.status(500).json({ erro: 'Erro ao carregar o calendário.' }); }
});

app.post('/calendario', autenticar, somenteGestao, async (req, res) => {
  try {
    const titulo = (req.body.titulo || '').trim();
    const data = (req.body.data || '').trim();
    if (!titulo || !data) return res.status(400).json({ erro: 'Informe a data e o título do evento.' });
    const semestre = (req.body.semestre || '').trim() || await getConfig('semestre_vigente', '2026.2');
    const modalidade = ['Presencial', 'Online'].includes(req.body.modalidade) ? req.body.modalidade : 'Presencial';
    const r = await pool.query(
      `INSERT INTO calendario (semestre, data, titulo, detalhe, modalidade) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (semestre, data, titulo) DO UPDATE SET detalhe = EXCLUDED.detalhe, modalidade = EXCLUDED.modalidade
       RETURNING id`,
      [semestre, data, titulo, (req.body.detalhe || '').trim() || null, modalidade]);
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) { console.error('Erro POST calendario:', e); res.status(500).json({ erro: 'Erro ao salvar o evento.' }); }
});

app.put('/calendario/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const titulo = (req.body.titulo || '').trim();
    const data = (req.body.data || '').trim();
    if (!titulo || !data) return res.status(400).json({ erro: 'Informe a data e o título do evento.' });
    const modalidade = ['Presencial', 'Online'].includes(req.body.modalidade) ? req.body.modalidade : 'Presencial';
    const r = await pool.query(
      `UPDATE calendario SET data = $1, titulo = $2, detalhe = $3, modalidade = $4 WHERE id = $5`,
      [data, titulo, (req.body.detalhe || '').trim() || null, modalidade, Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ erro: 'Evento não encontrado.' });
    res.json({ ok: true });
  } catch (e) { console.error('Erro PUT calendario:', e); res.status(500).json({ erro: 'Erro ao alterar o evento.' }); }
});

app.delete('/calendario/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM calendario WHERE id = $1`, [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ erro: 'Evento não encontrado.' });
    res.json({ ok: true });
  } catch (e) { console.error('Erro DELETE calendario:', e); res.status(500).json({ erro: 'Erro ao excluir o evento.' }); }
});

// Portal dos Pais: leitura do calendário do semestre vigente
app.get('/publico/portal/calendario', autenticarResponsavel, async (req, res) => {
  try { res.json(await montarCalendario(req.query.semestre)); }
  catch (e) { console.error('Erro calendario portal:', e); res.status(500).json({ erro: 'Erro ao carregar o calendário.' }); }
});

// ============================================================
// CIRCULARES (comunicados internos)
// ============================================================
const DESTINOS_CIRCULAR = ['professores', 'responsaveis', 'todos'];

app.get('/circulares', autenticar, async (req, res) => {
  try {
    const gestao = ['master', 'secretaria'].includes(req.usuario.perfil);
    if (gestao) {
      const r = await pool.query(
        `SELECT c.*, (SELECT COUNT(*) FROM circular_leituras l WHERE l.circular_id = c.id) AS leituras
         FROM circulares c ORDER BY c.criada_em DESC`);
      return res.json(r.rows);
    }
    const r = await pool.query(
      `SELECT c.id, c.numero, c.titulo, c.corpo, c.destino, c.semestre, c.criada_em,
              (l.usuario_id IS NOT NULL) AS lida, l.lida_em
       FROM circulares c
       LEFT JOIN circular_leituras l ON l.circular_id = c.id AND l.usuario_id = $1
       WHERE c.publicada = TRUE AND c.destino IN ('professores', 'todos')
       ORDER BY c.criada_em DESC`, [req.usuario.id]);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET circulares:', e); res.status(500).json({ erro: 'Erro ao listar as circulares.' }); }
});

app.post('/circulares', autenticar, somenteGestao, async (req, res) => {
  try {
    const titulo = (req.body.titulo || '').trim();
    const corpo = (req.body.corpo || '').trim();
    if (!titulo || !corpo) return res.status(400).json({ erro: 'Informe o título e o texto da circular.' });
    const destino = DESTINOS_CIRCULAR.includes(req.body.destino) ? req.body.destino : 'professores';
    const semestre = (req.body.semestre || '').trim() || await getConfig('semestre_vigente', '2026.2');
    const seq = await pool.query(`SELECT COUNT(*)::int AS n FROM circulares WHERE semestre = $1`, [semestre]);
    const numero = String(seq.rows[0].n + 1).padStart(3, '0') + '/' + semestre;
    const r = await pool.query(
      `INSERT INTO circulares (numero, titulo, corpo, destino, semestre, publicada, criada_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, numero`,
      [numero, titulo, corpo, destino, semestre, req.body.publicada !== false, req.usuario.id]);
    res.status(201).json(r.rows[0]);
  } catch (e) { console.error('Erro POST circular:', e); res.status(500).json({ erro: 'Erro ao criar a circular.' }); }
});

app.put('/circulares/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const titulo = (req.body.titulo || '').trim();
    const corpo = (req.body.corpo || '').trim();
    if (!titulo || !corpo) return res.status(400).json({ erro: 'Informe o título e o texto da circular.' });
    const destino = DESTINOS_CIRCULAR.includes(req.body.destino) ? req.body.destino : 'professores';
    const r = await pool.query(
      `UPDATE circulares SET titulo = $1, corpo = $2, destino = $3, publicada = $4 WHERE id = $5`,
      [titulo, corpo, destino, req.body.publicada !== false, Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ erro: 'Circular não encontrada.' });
    res.json({ ok: true });
  } catch (e) { console.error('Erro PUT circular:', e); res.status(500).json({ erro: 'Erro ao alterar a circular.' }); }
});

app.delete('/circulares/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM circulares WHERE id = $1`, [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ erro: 'Circular não encontrada.' });
    res.json({ ok: true });
  } catch (e) { console.error('Erro DELETE circular:', e); res.status(500).json({ erro: 'Erro ao excluir a circular.' }); }
});

// Confirmação de leitura pelo professor
app.post('/circulares/:id/lida', autenticar, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO circular_leituras (circular_id, usuario_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [Number(req.params.id), req.usuario.id]);
    res.json({ ok: true });
  } catch (e) { console.error('Erro marcar circular lida:', e); res.status(500).json({ erro: 'Erro ao confirmar a leitura.' }); }
});

// Quem já leu — controle da Gestão
app.get('/circulares/:id/leituras', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.nome, u.perfil, l.lida_em FROM circular_leituras l
       JOIN usuarios u ON u.id = l.usuario_id WHERE l.circular_id = $1 ORDER BY l.lida_em`,
      [Number(req.params.id)]);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET leituras:', e); res.status(500).json({ erro: 'Erro ao listar as leituras.' }); }
});

// ============================================================
// SISTEMA DE AVALIAÇÃO (composição da nota por bimestre)
// ============================================================
app.get('/avaliacao/modelo', autenticar, async (req, res) => {
  try { res.json(await getConfig('sistema_avaliacao', { bimestres: 2, nota_maxima: 10, etapas: { '1': [], '2': [] } })); }
  catch (e) { console.error('Erro GET modelo avaliacao:', e); res.status(500).json({ erro: 'Erro ao carregar o sistema de avaliação.' }); }
});

app.put('/avaliacao/modelo', autenticar, somenteGestao, async (req, res) => {
  try {
    const body = req.body || {};
    const etapas = {};
    for (const b of ['1', '2']) {
      const lista = Array.isArray(body.etapas && body.etapas[b]) ? body.etapas[b] : [];
      etapas[b] = lista
        .map(e => ({ nome: String(e.nome || '').trim(), peso: Number(e.peso) > 0 ? Number(e.peso) : 1 }))
        .filter(e => e.nome);
    }
    if (!etapas['1'].length && !etapas['2'].length) return res.status(400).json({ erro: 'Informe ao menos uma etapa.' });
    const modelo = {
      bimestres: 2,
      nota_maxima: Number(body.nota_maxima) > 0 ? Number(body.nota_maxima) : 10,
      etapas
    };
    await pool.query(
      `INSERT INTO configuracoes (chave, valor, descricao) VALUES ('sistema_avaliacao', $1, 'Composição da nota por bimestre (etapas e pesos) — base para as avaliações das turmas')
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`, [JSON.stringify(modelo)]);
    res.json(modelo);
  } catch (e) { console.error('Erro PUT modelo avaliacao:', e); res.status(500).json({ erro: 'Erro ao salvar o sistema de avaliação.' }); }
});

// Cria na turma as avaliações previstas para o bimestre, sem duplicar as já existentes
app.post('/professor/turmas/:id/avaliacoes/modelo', autenticar, somenteProfessor, async (req, res) => {
  try {
    if (!await podeTurma(req, req.params.id)) return res.status(403).json({ erro: 'Turma não vinculada ao seu cadastro.' });
    const bim = Number(req.body.bimestre);
    if (![1, 2].includes(bim)) return res.status(400).json({ erro: 'Informe o bimestre (1 ou 2).' });
    const modelo = await getConfig('sistema_avaliacao', null);
    const etapas = (modelo && modelo.etapas && modelo.etapas[String(bim)]) || [];
    if (!etapas.length) return res.status(400).json({ erro: 'O sistema de avaliação ainda não foi configurado pela Gestão.' });
    let criadas = 0;
    for (const et of etapas) {
      const ja = await pool.query(
        `SELECT 1 FROM avaliacoes WHERE turma_id = $1 AND nome = $2 AND bimestre IS NOT DISTINCT FROM $3`,
        [req.params.id, et.nome, bim]);
      if (ja.rows.length) continue;
      await pool.query(
        `INSERT INTO avaliacoes (turma_id, nome, peso, bimestre) VALUES ($1,$2,$3,$4)`,
        [req.params.id, et.nome, Number(et.peso) > 0 ? Number(et.peso) : 1, bim]);
      criadas++;
    }
    res.status(201).json({ criadas, total: etapas.length });
  } catch (e) { console.error('Erro aplicar modelo:', e); res.status(500).json({ erro: 'Erro ao criar as avaliações do bimestre.' }); }
});

// ============================================================
// BACKUP DO BANCO DE DADOS
// ============================================================
const somenteMaster = exigirPerfil('master');

// Ordem topológica: tabelas-pai antes das filhas, para o restauro respeitar as chaves estrangeiras
async function tabelasEmOrdem() {
  const t = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const nomes = t.rows.map(r => r.table_name);
  const dep = await pool.query(
    `SELECT tc.table_name AS filho, ccu.table_name AS pai
     FROM information_schema.table_constraints tc
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`);
  const pais = {};
  nomes.forEach(n => { pais[n] = new Set(); });
  for (const d of dep.rows) {
    // auto-referência não cria dependência entre tabelas
    if (d.filho !== d.pai && pais[d.filho] && nomes.includes(d.pai)) pais[d.filho].add(d.pai);
  }
  const ordem = [], visto = new Set();
  const visitar = (n, caminho) => {
    if (visto.has(n) || caminho.has(n)) return;   // ciclo: resolve na ordem alfabética
    caminho.add(n);
    for (const p of pais[n]) visitar(p, caminho);
    caminho.delete(n);
    visto.add(n); ordem.push(n);
  };
  nomes.forEach(n => visitar(n, new Set()));
  return ordem;
}

// Colunas BYTEA por tabela — são os anexos e as fotos, que pesam no arquivo
async function colunasBinarias() {
  const r = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type = 'bytea'`);
  const mapa = {};
  for (const c of r.rows) (mapa[c.table_name] = mapa[c.table_name] || []).push(c.column_name);
  return mapa;
}

app.get('/admin/backup/resumo', autenticar, somenteMaster, async (req, res) => {
  try {
    const ordem = await tabelasEmOrdem();
    const bin = await colunasBinarias();
    const tabelas = [];
    let totalLinhas = 0, totalBytes = 0;
    for (const nome of ordem) {
      const c = await pool.query(`SELECT COUNT(*)::int AS n FROM "${nome}"`);
      const s = await pool.query(`SELECT pg_total_relation_size($1)::bigint AS b`, [nome]);
      const bytes = Number(s.rows[0].b);
      totalLinhas += c.rows[0].n; totalBytes += bytes;
      tabelas.push({ tabela: nome, linhas: c.rows[0].n, bytes, tem_arquivos: !!bin[nome] });
    }
    res.json({ gerado_em: new Date().toISOString(), tabelas, total_linhas: totalLinhas, total_bytes: totalBytes });
  } catch (e) { console.error('Erro resumo backup:', e); res.status(500).json({ erro: 'Erro ao ler o resumo do banco.' }); }
});

// Backup completo em JSON. arquivos=1 inclui fotos e anexos (arquivo bem maior)
app.get('/admin/backup', autenticar, somenteMaster, async (req, res) => {
  try {
    const incluirArquivos = String(req.query.arquivos || '') === '1';
    const ordem = await tabelasEmOrdem();
    const bin = await colunasBinarias();
    const dump = {
      sistema: 'CEMIC — Sistema de Gestão Escolar',
      versao_backend: '3.35',
      gerado_em: new Date().toISOString(),
      gerado_por: req.usuario.id,
      inclui_arquivos: incluirArquivos,
      ordem,
      contagem: {},
      tabelas: {}
    };
    let arquivosOmitidos = 0;
    for (const nome of ordem) {
      const r = await pool.query(`SELECT * FROM "${nome}"`);
      const cols = bin[nome] || [];
      const linhas = r.rows.map(linha => {
        for (const col of cols) {
          if (linha[col] == null) continue;
          if (incluirArquivos) linha[col] = { __bytea: Buffer.from(linha[col]).toString('base64') };
          else { linha[col] = null; arquivosOmitidos++; }
        }
        return linha;
      });
      dump.tabelas[nome] = linhas;
      dump.contagem[nome] = linhas.length;
    }
    dump.arquivos_omitidos = arquivosOmitidos;
    const nomeArq = `cemic-backup-${new Date().toISOString().slice(0, 10)}${incluirArquivos ? '-com-arquivos' : ''}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArq}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    console.log(`Backup gerado por usuário ${req.usuario.id} — arquivos: ${incluirArquivos}`);
    res.send(JSON.stringify(dump));
  } catch (e) { console.error('Erro backup:', e); res.status(500).json({ erro: 'Erro ao gerar o backup.' }); }
});

// Restauro. Por segurança só roda com confirmação explícita; substituir=true apaga o que existe.
app.post('/admin/backup/restaurar', express.json({ limit: '250mb' }), autenticar, somenteMaster, async (req, res) => {
  const cliente = await pool.connect();
  try {
    const body = req.body || {};
    if (body.confirmacao !== 'RESTAURAR') {
      return res.status(400).json({ erro: 'Envie confirmacao: "RESTAURAR" para executar o restauro.' });
    }
    const dump = body.backup;
    if (!dump || !dump.tabelas || !Array.isArray(dump.ordem)) {
      return res.status(400).json({ erro: 'Arquivo de backup inválido.' });
    }
    const substituir = body.substituir === true;
    const ordemBanco = await tabelasEmOrdem();
    const alvo = dump.ordem.filter(t => ordemBanco.includes(t));

    if (!substituir) {
      for (const t of alvo) {
        const c = await cliente.query(`SELECT 1 FROM "${t}" LIMIT 1`);
        if (c.rows.length) {
          return res.status(409).json({ erro: `A tabela "${t}" já tem dados. Para sobrescrever, envie substituir: true.` });
        }
      }
    }

    await cliente.query('BEGIN');
    if (substituir) {
      await cliente.query(`TRUNCATE ${alvo.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
    }
    const restaurado = {};
    for (const t of alvo) {
      const linhas = dump.tabelas[t] || [];
      for (const linha of linhas) {
        const cols = Object.keys(linha);
        if (!cols.length) continue;
        const vals = cols.map(k => {
          const v = linha[k];
          return (v && typeof v === 'object' && v.__bytea) ? Buffer.from(v.__bytea, 'base64') : v;
        });
        await cliente.query(
          `INSERT INTO "${t}" (${cols.map(c => `"${c}"`).join(',')})
           VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')}) ON CONFLICT DO NOTHING`, vals);
      }
      restaurado[t] = linhas.length;
      // realinha a sequência do id para os próximos cadastros não colidirem
      await cliente.query(
        `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM "${t}"), 1))
         WHERE pg_get_serial_sequence($1, 'id') IS NOT NULL`, [t]);
    }
    await cliente.query('COMMIT');
    console.log(`Restauro concluído por usuário ${req.usuario.id} — substituir: ${substituir}`);
    res.json({ ok: true, substituir, tabelas: restaurado });
  } catch (e) {
    try { await cliente.query('ROLLBACK'); } catch (x) {}
    console.error('Erro restaurar backup:', e);
    res.status(500).json({ erro: 'Erro ao restaurar: ' + e.message + ' — nada foi alterado.' });
  } finally {
    cliente.release();
  }
});

// ---------- Folha de professores (hora-aula) ----------
app.post('/admin/professor-horas', autenticar, somenteGestao, async (req, res) => {
  try {
    const professorId = Number(req.body.professor_id);
    const data = req.body.data;
    const horas = Number(req.body.horas);
    const valorHora = Number(req.body.valor_hora);
    const observacao = (req.body.observacao || '').trim() || null;
    if (!professorId) return res.status(400).json({ erro: 'Selecione o professor.' });
    if (!data) return res.status(400).json({ erro: 'Informe a data.' });
    if (!(horas > 0)) return res.status(400).json({ erro: 'Informe a quantidade de horas-aula.' });
    if (!(valorHora >= 0)) return res.status(400).json({ erro: 'Informe o valor da hora-aula.' });
    const p = await pool.query(`SELECT 1 FROM professores WHERE id = $1`, [professorId]);
    if (!p.rows.length) return res.status(404).json({ erro: 'Professor não encontrado.' });
    const r = await pool.query(
      `INSERT INTO professor_horas (professor_id, data, horas, valor_hora, observacao)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [professorId, data, horas, valorHora, observacao]);
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) { console.error('Erro POST professor-horas:', e); res.status(500).json({ erro: 'Erro ao lançar as horas-aula.' }); }
});

app.get('/admin/professor-horas', autenticar, somenteGestao, async (req, res) => {
  try {
    const cond = [], params = [];
    if (req.query.professor_id) { params.push(Number(req.query.professor_id)); cond.push(`ph.professor_id = $${params.length}`); }
    if (req.query.mes) { params.push(req.query.mes); cond.push(`to_char(ph.data, 'YYYY-MM') = $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await pool.query(
      `SELECT ph.id, ph.professor_id, ph.data, ph.horas, ph.valor_hora, ph.observacao,
              (ph.horas * ph.valor_hora) AS total, p.nome AS professor_nome
       FROM professor_horas ph
       JOIN professores p ON p.id = ph.professor_id
       ${where}
       ORDER BY p.nome, ph.data`, params);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET professor-horas:', e); res.status(500).json({ erro: 'Erro ao listar as horas-aula.' }); }
});

app.delete('/admin/professor-horas/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM professor_horas WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Lançamento não encontrado.' });
    res.json({ ok: true });
  } catch (e) { console.error('Erro DELETE professor-horas:', e); res.status(500).json({ erro: 'Erro ao remover o lançamento.' }); }
});

// ---------- Pagamentos aos professores (baixas) ----------
app.post('/admin/professor-pagamentos', autenticar, somenteGestao, async (req, res) => {
  try {
    const professorId = Number(req.body.professor_id);
    const referencia = (req.body.referencia || '').trim();
    const dataPagamento = req.body.data_pagamento;
    const valor = Number(req.body.valor);
    const forma = (req.body.forma || '').trim() || null;
    const observacao = (req.body.observacao || '').trim() || null;
    if (!professorId) return res.status(400).json({ erro: 'Selecione o professor.' });
    if (!/^\d{4}-\d{2}$/.test(referencia)) return res.status(400).json({ erro: 'Mês de referência inválido.' });
    if (!dataPagamento) return res.status(400).json({ erro: 'Informe a data do pagamento.' });
    if (!(valor > 0)) return res.status(400).json({ erro: 'Informe o valor pago.' });
    const p = await pool.query(`SELECT 1 FROM professores WHERE id = $1`, [professorId]);
    if (!p.rows.length) return res.status(404).json({ erro: 'Professor não encontrado.' });
    const r = await pool.query(
      `INSERT INTO professor_pagamentos (professor_id, referencia, data_pagamento, valor, forma, observacao)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [professorId, referencia, dataPagamento, valor, forma, observacao]);
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) { console.error('Erro POST professor-pagamentos:', e); res.status(500).json({ erro: 'Erro ao registrar o pagamento.' }); }
});

app.get('/admin/professor-pagamentos', autenticar, somenteGestao, async (req, res) => {
  try {
    const cond = [], params = [];
    if (req.query.professor_id) { params.push(Number(req.query.professor_id)); cond.push(`pg.professor_id = $${params.length}`); }
    if (req.query.mes) { params.push(req.query.mes); cond.push(`pg.referencia = $${params.length}`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await pool.query(
      `SELECT pg.id, pg.professor_id, pg.referencia, pg.data_pagamento, pg.valor, pg.forma, pg.observacao,
              p.nome AS professor_nome
       FROM professor_pagamentos pg
       JOIN professores p ON p.id = pg.professor_id
       ${where}
       ORDER BY pg.data_pagamento, pg.id`, params);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET professor-pagamentos:', e); res.status(500).json({ erro: 'Erro ao listar os pagamentos.' }); }
});

app.delete('/admin/professor-pagamentos/:id', autenticar, somenteGestao, async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM professor_pagamentos WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Pagamento não encontrado.' });
    res.json({ ok: true });
  } catch (e) { console.error('Erro DELETE professor-pagamentos:', e); res.status(500).json({ erro: 'Erro ao remover o pagamento.' }); }
});

// Saldo consolidado do mês: devido (horas-aula) x pago (baixas)
app.get('/admin/professor-folha', autenticar, somenteGestao, async (req, res) => {
  try {
    const mes = req.query.mes;
    if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return res.status(400).json({ erro: 'Informe o mês (AAAA-MM).' });
    const r = await pool.query(
      `SELECT p.id AS professor_id, p.nome AS professor_nome,
              COALESCE(h.horas, 0) AS horas,
              COALESCE(h.devido, 0) AS devido,
              COALESCE(g.pago, 0) AS pago,
              COALESCE(h.devido, 0) - COALESCE(g.pago, 0) AS saldo
       FROM professores p
       LEFT JOIN (
         SELECT professor_id, SUM(horas) AS horas, SUM(horas * valor_hora) AS devido
         FROM professor_horas WHERE to_char(data, 'YYYY-MM') = $1 GROUP BY professor_id
       ) h ON h.professor_id = p.id
       LEFT JOIN (
         SELECT professor_id, SUM(valor) AS pago
         FROM professor_pagamentos WHERE referencia = $1 GROUP BY professor_id
       ) g ON g.professor_id = p.id
       WHERE COALESCE(h.devido, 0) <> 0 OR COALESCE(g.pago, 0) <> 0
       ORDER BY p.nome`, [mes]);
    res.json(r.rows);
  } catch (e) { console.error('Erro GET professor-folha:', e); res.status(500).json({ erro: 'Erro ao apurar a folha.' }); }
});

// ---------- Alteração de turma (transfere matrícula ativa sem cancelar) ----------
app.put('/admin/matriculas/:id/turma', autenticar, somenteGestao, async (req, res) => {
  try {
    const matId = Number(req.params.id);
    const novaTurmaId = Number(req.body.turma_id);
    if (!novaTurmaId) return res.status(400).json({ erro: 'Selecione a turma de destino.' });
    const mr = await pool.query(`SELECT * FROM matriculas WHERE id = $1`, [matId]);
    const mat = mr.rows[0];
    if (!mat) return res.status(404).json({ erro: 'Matrícula não encontrada.' });
    if (mat.status !== 'ativa') return res.status(409).json({ erro: 'Só é possível alterar a turma de uma matrícula ativa.' });
    if (mat.turma_id === novaTurmaId) return res.status(400).json({ erro: 'A turma de destino é a mesma da turma atual.' });
    const tr = await pool.query(`SELECT * FROM turmas WHERE id = $1`, [novaTurmaId]);
    const turma = tr.rows[0];
    if (!turma) return res.status(404).json({ erro: 'Turma de destino não encontrada.' });
    if (turma.status === 'encerrada') return res.status(409).json({ erro: 'A turma de destino está encerrada.' });
    const dup = await pool.query(`SELECT 1 FROM matriculas WHERE aluno_id = $1 AND turma_id = $2 AND status IN ('ativa','trancada')`, [mat.aluno_id, novaTurmaId]);
    if (dup.rows.length) return res.status(409).json({ erro: 'O aluno já possui matrícula ativa nessa turma.' });
    const ocup = await pool.query(`SELECT COUNT(*)::int AS n FROM matriculas WHERE turma_id = $1 AND status = 'ativa'`, [novaTurmaId]);
    if (ocup.rows[0].n >= turma.capacidade) return res.status(409).json({ erro: 'A turma de destino está lotada.' });
    await pool.query(`UPDATE matriculas SET turma_id = $1 WHERE id = $2`, [novaTurmaId, matId]);
    res.json({ ok: true, turma_id: novaTurmaId });
  } catch (e) { console.error('Erro alterar turma:', e); res.status(500).json({ erro: 'Erro ao alterar a turma.' }); }
});

// ---------- Relatório: pais cadastrados no Portal, por turma ----------
app.get('/admin/relatorios/pais-por-turma', autenticar, somenteGestao, async (req, res) => {
  try {
    const params = [];
    let filtroSem = '';
    if (req.query.semestre) { params.push(req.query.semestre); filtroSem = ` AND t.semestre = $${params.length}`; }
    if (req.query.turma_id) { params.push(Number(req.query.turma_id)); filtroSem += ` AND t.id = $${params.length}`; }
    const r = await pool.query(
      `SELECT t.id AS turma_id, t.nome AS turma_nome, t.turno, t.semestre,
              c.nome AS curso_nome, n.nome AS nivel_nome,
              a.id AS aluno_id, a.nome AS aluno_nome,
              r.nome AS responsavel_nome, r.cpf AS responsavel_cpf, r.whatsapp AS responsavel_whatsapp,
              ar.parentesco, (r.senha_hash IS NOT NULL) AS cadastrado
       FROM matriculas m
       JOIN alunos a ON a.id = m.aluno_id
       JOIN turmas t ON t.id = m.turma_id
       JOIN niveis n ON n.id = t.nivel_id
       JOIN cursos c ON c.id = n.curso_id
       LEFT JOIN aluno_responsavel ar ON ar.aluno_id = a.id
       LEFT JOIN responsaveis r ON r.id = ar.responsavel_id
       WHERE m.status = 'ativa'${filtroSem}
       ORDER BY t.nome, a.nome, r.nome`, params);
    res.json(r.rows);
  } catch (e) { console.error('Erro relatório pais por turma:', e); res.status(500).json({ erro: 'Erro ao gerar o relatório.' }); }
});

app.get('/admin/pre-inscricoes', autenticar, somenteGestao, async (req, res) => {
  try {
    const cond = []; const params = [];
    if (req.query.status) { params.push(req.query.status); cond.push(`status = $${params.length}`); }
    if (req.query.tipo) { params.push(req.query.tipo); cond.push(`tipo = $${params.length}`); }
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
    res.json({
      status: (erroInicializacao || falhasMigracao.length) ? 'degradado' : 'ok',
      sistema: 'CEMIC Gestão',
      versao: '3.35 (Backup do banco de dados)',
      inicializacao: erroInicializacao || 'ok',
      migracoes_com_falha: falhasMigracao
    });
  } catch {
    res.status(500).json({ status: 'erro', detalhe: 'Banco de dados inacessível.' });
  }
});

const PORT = process.env.PORT || 3000;
let erroInicializacao = null;
initDB()
  .catch(e => {
    erroInicializacao = e.message;
    console.error('Falha ao inicializar o banco:', e);
  })
  .finally(() => app.listen(PORT, () => {
    console.log(`CEMIC Gestão — backend v3.35 rodando na porta ${PORT}`);
    if (erroInicializacao) console.error('ATENÇÃO: o sistema subiu com falha de inicialização —', erroInicializacao);
    if (falhasMigracao.length) console.error('ATENÇÃO: migrações com falha —', falhasMigracao.join(' | '));
  }));
