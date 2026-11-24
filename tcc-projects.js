const { Document, Packer, Paragraph, TextRun, AlignmentType, PageBreak } = require('docx');
const db = require('./database');

async function initTccProjects() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurado.');
  await db.query(`
    CREATE TABLE IF NOT EXISTS tcc_projects (
      id BIGSERIAL PRIMARY KEY,
      discord_user_id VARCHAR(32) NOT NULL,
      discord_username VARCHAR(100) NOT NULL,
      guild_id VARCHAR(32),
      student_name VARCHAR(100) NOT NULL,
      advisor_name VARCHAR(100) NOT NULL,
      institution VARCHAR(120) NOT NULL,
      course VARCHAR(100) NOT NULL,
      title VARCHAR(250) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tcc_projects_user_created
      ON tcc_projects (discord_user_id, created_at DESC);
  `);
  console.log('📚 Tabela de projetos de TCC verificada.');
}

async function saveProject({ userId, username, guildId, studentName, advisorName, institution, course, title }) {
  const result = await db.query(
    `INSERT INTO tcc_projects
      (discord_user_id, discord_username, guild_id, student_name, advisor_name, institution, course, title)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [
      String(userId),
      String(username || 'desconhecido').slice(0, 100),
      guildId ? String(guildId) : null,
      String(studentName || '').trim(),
      String(advisorName || '').trim(),
      String(institution || '').trim(),
      String(course || '').trim(),
      String(title || '').trim()
    ]
  );
  return result.rows[0];
}

function centered(text, options = {}) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: options.after ?? 240, line: options.line ?? 240 },
    children: [
      new TextRun({
        text: String(text || ''),
        bold: Boolean(options.bold),
        size: options.size ?? 24,
        font: 'Times New Roman'
      })
    ]
  });
}

function natureBlock(text, options = {}) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    indent: { left: 4535 }, // ~8 cm deslocado à direita conforme padrão de folha de rosto ABNT
    spacing: { after: options.after ?? 240, line: 240 },
    children: [
      new TextRun({
        text: String(text || ''),
        size: 20, // 10pt na folha de rosto costuma ser usado em notas/natureza do trabalho
        font: 'Times New Roman'
      })
    ]
  });
}

function body(text) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 709 }, // ~1,25 cm recuo de primeira linha
    spacing: { after: 120, line: 360 }, // espaçamento 1,5 entre linhas (240 = simples, 360 = 1,5)
    children: [
      new TextRun({
        text: String(text || ''),
        size: 24, // 12pt
        font: 'Times New Roman'
      })
    ]
  });
}

function sectionHeading(title) {
  return new Paragraph({
    heading: 'Heading1',
    spacing: { before: 240, after: 120, line: 360 },
    children: [
      new TextRun({
        text: String(title || '').toUpperCase(),
        bold: true,
        font: 'Times New Roman',
        size: 24
      })
    ]
  });
}

async function generateTccDocx(project) {
  const currentYear = new Date().getFullYear();
  const institution = String(project.institution || '').trim().toUpperCase();
  const studentName = String(project.studentName || '').trim().toUpperCase();
  const title = String(project.title || '').trim().toUpperCase();
  const course = String(project.course || '').trim();
  const advisorName = String(project.advisorName || '').trim();

  const doc = new Document({
    creator: 'Assistente TCC ABNT',
    title: project.title,
    description: 'Modelo inicial de TCC estruturado conforme orientações ABNT para revisão.',
    styles: {
      default: {
        document: {
          run: { font: 'Times New Roman', size: 24 },
          paragraph: { spacing: { line: 360, after: 120 } }
        }
      }
    },
    sections: [
      {
        properties: {
          page: {
            // Margens ABNT: superior e esquerda 3 cm (1701 twips); inferior e direita 2 cm (1134 twips)
            margin: { top: 1701, right: 1134, bottom: 1134, left: 1701 }
          }
        },
        children: [
          // 1. CAPA
          centered(institution, { bold: true, after: 1400 }),
          centered(studentName, { bold: true, after: 1800 }),
          centered(title, { bold: true, after: 2200 }),
          centered('Caraguatatuba', { bold: true, after: 120 }),
          centered(String(currentYear), { bold: true }),

          new Paragraph({ children: [new PageBreak()] }),

          // 2. FOLHA DE ROSTO
          centered(studentName, { after: 1200 }),
          centered(title, { bold: true, after: 1400 }),
          natureBlock(
            `Trabalho de Conclusão de Curso apresentado ao curso de ${course}, da instituição ${institution}, como requisito parcial para obtenção de título/conclusão do curso.`,
            { after: 240 }
          ),
          natureBlock(`Orientador(a): ${advisorName}`, { after: 2000 }),
          centered('Caraguatatuba', { after: 120 }),
          centered(String(currentYear)),

          new Paragraph({ children: [new PageBreak()] }),

          // 3. ELEMENTOS TEXTUAIS (MODELO INICIAL PARA REVISÃO)
          sectionHeading('1 INTRODUÇÃO'),
          body(
            'Apresente aqui a contextualização do tema, o problema de pesquisa, a justificativa e os objetivos do trabalho. Este arquivo é um modelo estrutural inicial e deve ser complementado com pesquisa acadêmica e revisão do seu orientador.'
          ),

          sectionHeading('2 OBJETIVOS'),
          body(
            'Defina o objetivo geral do trabalho e os objetivos específicos que orientarão a investigação.'
          ),

          sectionHeading('3 METODOLOGIA'),
          body(
            'Descreva o tipo de pesquisa, os procedimentos de coleta e análise de dados e os critérios adotados no estudo.'
          ),

          sectionHeading('REFERÊNCIAS'),
          body(
            'Liste aqui apenas as obras e fontes efetivamente citadas no texto, seguindo as normas da ABNT e o manual da sua instituição de ensino.'
          ),

          new Paragraph({
            spacing: { before: 240 },
            children: [
              new TextRun({
                text: 'Nota: modelo inicial gerado automaticamente. Confira as normas ABNT vigentes e as regras específicas da sua instituição antes da entrega final.',
                italics: true,
                size: 20,
                font: 'Times New Roman'
              })
            ]
          })
        ]
      }
    ]
  });

  return Packer.toBuffer(doc);
}

module.exports = { initTccProjects, saveProject, generateTccDocx };
