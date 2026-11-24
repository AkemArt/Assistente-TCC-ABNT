const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
  PageBreak
} = require('docx');
const PptxGenJS = require('pptxgenjs');
const db = require('./database');

async function initTccProjects() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não configurado.');
  }

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

async function saveProject({
  userId,
  username,
  guildId,
  studentName,
  advisorName,
  institution,
  course,
  title
}) {
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

function parseCourseAndInstitution(rawCourseInst, fallbackCourse, fallbackInst) {
  const text = String(rawCourseInst || '').trim();
  if (!text) {
    return {
      course: String(fallbackCourse || 'Curso de Graduação').trim(),
      institution: String(fallbackInst || 'Instituição de Ensino').trim()
    };
  }

  const separators = [' - ', ' – ', ' — ', ' / ', '|', ';'];
  for (const sep of separators) {
    if (text.includes(sep)) {
      const [left, ...rest] = text.split(sep);
      const right = rest.join(sep).trim();
      if (left.trim() && right) {
        return {
          course: left.trim(),
          institution: right
        };
      }
    }
  }

  return {
    course: text,
    institution: String(fallbackInst || text).trim()
  };
}

function parsePageCount(rawPages) {
  const match = String(rawPages || '').match(/\d+/);
  const num = match ? parseInt(match[0], 10) : 10;
  if (!Number.isFinite(num) || num < 5) return 10;
  if (num > 60) return 60;
  return num;
}

function getThemePalette(title, course) {
  const combined = `${title} ${course}`.toLowerCase();

  if (
    combined.includes('saúde') ||
    combined.includes('saude') ||
    combined.includes('enferm') ||
    combined.includes('medicin') ||
    combined.includes('psicolog') ||
    combined.includes('biolog')
  ) {
    return {
      primary: '0F766E',
      secondary: '134E4A',
      accent: '14B8A6',
      lightBg: 'F0FDFA',
      textDark: '0F172A',
      textMuted: '475569'
    };
  }

  if (
    combined.includes('agro') ||
    combined.includes('ambient') ||
    combined.includes('sustent') ||
    combined.includes('ecolog')
  ) {
    return {
      primary: '166534',
      secondary: '14532D',
      accent: '22C55E',
      lightBg: 'F0FDF4',
      textDark: '0F172A',
      textMuted: '475569'
    };
  }

  if (
    combined.includes('direito') ||
    combined.includes('admin') ||
    combined.includes('contab') ||
    combined.includes('gest') ||
    combined.includes('negoc')
  ) {
    return {
      primary: '1E3A8A',
      secondary: '172554',
      accent: 'D97706',
      lightBg: 'EFF6FF',
      textDark: '0F172A',
      textMuted: '475569'
    };
  }

  return {
    primary: '1D4ED8',
    secondary: '0F172A',
    accent: '38BDF8',
    lightBg: 'F8FAFC',
    textDark: '0F172A',
    textMuted: '475569'
  };
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
    indent: { left: 4535 }, // ~8 cm deslocado à direita conforme padrão ABNT de folha de rosto
    spacing: { after: options.after ?? 240, line: options.line ?? 240 },
    children: [
      new TextRun({
        text: String(text || ''),
        size: 20, // 10pt na nota descritiva da folha de rosto
        font: 'Times New Roman'
      })
    ]
  });
}

function body(text, options = {}) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { firstLine: 709 }, // ~1,25 cm recuo de primeira linha
    spacing: { after: options.after ?? 120, line: 360 }, // espaçamento 1,5 entre linhas
    children: [
      new TextRun({
        text: String(text || ''),
        size: 24, // 12pt
        font: 'Times New Roman'
      })
    ]
  });
}

function quoteBlock(text) {
  return new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    indent: { left: 2268 }, // 4 cm recuo à esquerda para citação longa ABNT
    spacing: { before: 120, after: 120, line: 240 }, // espaçamento simples e fonte 10pt
    children: [
      new TextRun({
        text: String(text || ''),
        size: 20,
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

function referenceItem(text) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { after: 240, line: 240 }, // espaçamento simples entre linhas e espaço entre referências
    children: [
      new TextRun({
        text: String(text || ''),
        size: 24,
        font: 'Times New Roman'
      })
    ]
  });
}

function buildExpansionParagraphs(topicTitle, targetPages) {
  const extraCount = Math.max(0, Math.round((targetPages - 8) / 2));
  const paragraphs = [];

  for (let i = 1; i <= extraCount; i += 1) {
    paragraphs.push(
      body(
        `No desdobramento de ${topicTitle} (etapa ${i}), observa-se que a padronização de processos e o registro sistemático de evidências reduzem falhas operacionais e ampliam a transparência institucional. Conforme apontam Gil (2019) e Lakatos e Marconi (2021), a articulação entre fundamentação teórica e análise criteriosa permite validar hipóteses com maior rigor acadêmico.`
      )
    );
  }

  return paragraphs;
}

async function generateTccDocx(project) {
  const currentYear = new Date().getFullYear();
  const parsed = parseCourseAndInstitution(
    project.courseAndInstitution || project.course,
    project.course,
    project.institution
  );
  const targetPages = parsePageCount(project.pageCount);
  const focusNote = String(project.focusNote || '').trim();

  const institution = parsed.institution.toUpperCase();
  const studentName = String(project.studentName || '').trim().toUpperCase();
  const title = String(project.title || '').trim().toUpperCase();
  const course = parsed.course;
  const advisorName = String(project.advisorName || '').trim();
  const city = String(project.city || 'Caraguatatuba').trim();

  const children = [
    // CAPA (ABNT NBR 14724)
    centered(institution, { bold: true, after: 480 }),
    centered(course.toUpperCase(), { bold: true, after: 1200 }),
    centered(studentName, { after: 1800 }),
    centered(title, { bold: true, after: 2200 }),
    centered(city.toUpperCase(), { after: 120 }),
    centered(String(currentYear)),

    new Paragraph({ children: [new PageBreak()] }),

    // FOLHA DE ROSTO (ABNT NBR 14724)
    centered(studentName, { after: 1200 }),
    centered(title, { bold: true, after: 1200 }),
    natureBlock(
      `Trabalho de Conclusão de Curso apresentado ao curso de ${course}, da instituição ${institution}, como requisito parcial para obtenção de grau/conclusão do curso (estrutura planejada para aproximadamente ${targetPages} páginas).`,
      { after: 240 }
    ),
    natureBlock(`Orientador(a): ${advisorName}`, { after: 2000 }),
    centered(city.toUpperCase(), { after: 120 }),
    centered(String(currentYear)),

    new Paragraph({ children: [new PageBreak()] }),

    // 1 INTRODUÇÃO, PROBLEMA E SOLUÇÃO
    sectionHeading('1 INTRODUÇÃO, PROBLEMA E PROPOSTA DE SOLUÇÃO'),
    body(
      `O presente trabalho aborda o tema "${project.title}" no contexto do curso de ${course}, buscando oferecer uma base estruturada e fundamentada para análise acadêmica e aplicação prática. De acordo com Gil (2019), a pesquisa científica exige delimitação clara do problema e coerência entre os objetivos propostos e os procedimentos metodológicos adotados.`
    ),
    body(
      `Problema de pesquisa: como estruturar e aplicar soluções eficazes voltadas a "${project.title}" de modo a superar gargalos operacionais, falta de padronização e baixa previsibilidade de resultados no cenário investigado? ${focusNote ? `Considera-se ainda o direcionamento informado: ${focusNote}.` : ''}`
    ),
    body(
      `Proposta de solução: propõe-se a adoção de um modelo estruturado em etapas — contemplando diagnóstico do cenário atual, definição de requisitos e indicadores, implementação de solução prática/metodológica e validação contínua — permitindo ao autor adaptar e aprofundar cada seção com o acompanhamento do(a) orientador(a) ${advisorName}.`
    ),
    ...buildExpansionParagraphs('a contextualização e a solução proposta', targetPages),

    // 2 OBJETIVOS
    sectionHeading('2 OBJETIVOS'),
    body(
      `Objetivo geral: analisar "${project.title}" e apresentar uma proposta estruturada e fundamentada na literatura acadêmica para responder ao problema de pesquisa definido.`
    ),
    body(
      'Objetivos específicos: (a) levantar conceitos e estudos científicos relevantes sobre o tema; (b) identificar os principais desafios e pontos críticos do problema investigado; (c) delinear uma solução viável e replicável; e (d) consolidar conclusões e recomendações para trabalhos futuros.'
    ),

    // 3 FUNDAMENTAÇÃO TEÓRICA E METODOLOGIA
    sectionHeading('3 FUNDAMENTAÇÃO TEÓRICA E METODOLOGIA'),
    body(
      'Segundo Lakatos e Marconi (2021), a revisão bibliográfica e a definição metodológica conferem sustentação científica ao estudo, permitindo confrontar diferentes perspectivas de autores reconhecidos na área.'
    ),
    quoteBlock(
      'A pesquisa científica depende de um procedimento metódico para tratar o problema investigado, devendo o pesquisador explicitar os critérios, fontes e limites do estudo de forma objetiva e verificável (GIL, 2019, p. 26).'
    ),
    body(
      'Quanto aos procedimentos metodológicos, este trabalho adota abordagem qualitativa e descritiva, apoiada em pesquisa bibliográfica e documental em artigos científicos, livros técnicos e normas vigentes. Recomenda-se que o aluno complemente esta seção com dados empíricos, estudos de caso ou resultados obtidos durante o desenvolvimento do projeto.'
    ),
    ...buildExpansionParagraphs('a fundamentação teórica e os procedimentos metodológicos', targetPages),

    // 4 CONCLUSÃO
    sectionHeading('4 CONCLUSÃO'),
    body(
      `Conclui-se que a investigação sobre "${project.title}" evidencia a importância de estruturar soluções claras, documentadas e alinhadas aos objetivos propostos. A abordagem apresentada fornece um alicerce consistente para o desenvolvimento do trabalho, restando ao autor refinar os dados específicos e validar os resultados finais junto ao(à) orientador(a) ${advisorName}.`
    ),
    body(
      'Como recomendações para continuidade, sugere-se ampliar a coleta de evidências práticas, revisar periodicamente as atualizações normativas e técnicas da área e confrontar os resultados obtidos com novos estudos publicados.'
    ),

    // REFERÊNCIAS (ABNT NBR 6023)
    sectionHeading('REFERÊNCIAS'),
    referenceItem(
      'ASSOCIAÇÃO BRASILEIRA DE NORMAS TÉCNICAS. NBR 14724: informação e documentação — trabalhos acadêmicos — apresentação. Rio de Janeiro: ABNT, 2011.'
    ),
    referenceItem(
      'ASSOCIAÇÃO BRASILEIRA DE NORMAS TÉCNICAS. NBR 6023: informação e documentação — referências — elaboração. Rio de Janeiro: ABNT, 2018.'
    ),
    referenceItem(
      'GIL, Antonio Carlos. Métodos e técnicas de pesquisa social. 7. ed. São Paulo: Atlas, 2019.'
    ),
    referenceItem(
      'LAKATOS, Eva Maria; MARCONI, Marina de Andrade. Fundamentos de metodologia científica. 9. ed. São Paulo: Atlas, 2021.'
    ),
    referenceItem(
      'SEVERINO, Antônio Joaquim. Metodologia do trabalho científico. 24. ed. São Paulo: Cortez, 2016.'
    ),

    new Paragraph({
      spacing: { before: 240 },
      children: [
        new TextRun({
          text: 'Observação: este documento é um modelo inicial estruturado para revisão e edição do aluno e do(a) orientador(a). Verifique as normas ABNT vigentes e as exigências específicas da instituição antes da entrega final.',
          italics: true,
          size: 20,
          font: 'Times New Roman'
        })
      ]
    })
  ];

  const doc = new Document({
    creator: 'Assistente TCC ABNT',
    title: project.title,
    description: 'Modelo de TCC estruturado conforme normas ABNT para revisão.',
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
        children
      }
    ]
  });

  return Packer.toBuffer(doc);
}

async function generateTccPptx(project) {
  const parsed = parseCourseAndInstitution(
    project.courseAndInstitution || project.course,
    project.course,
    project.institution
  );
  const focusNote = String(project.focusNote || '').trim();
  const palette = getThemePalette(project.title, parsed.course);
  const currentYear = new Date().getFullYear();

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = String(project.studentName || 'Aluno');
  pptx.title = String(project.title || 'Apresentação de TCC');
  pptx.subject = `${parsed.course} - ${parsed.institution}`;

  // Slide 1: Capa temática profissional
  const s1 = pptx.addSlide();
  s1.background = { color: palette.secondary };
  s1.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 0.35,
    h: 7.5,
    fill: { color: palette.accent }
  });
  s1.addText(`${parsed.institution.toUpperCase()} • ${parsed.course.toUpperCase()}`, {
    x: 0.8,
    y: 0.9,
    w: 11.8,
    h: 0.4,
    fontSize: 13,
    bold: true,
    color: palette.accent
  });
  s1.addText(String(project.title || 'Projeto de TCC'), {
    x: 0.8,
    y: 1.7,
    w: 11.5,
    h: 2.2,
    fontSize: 32,
    bold: true,
    color: 'FFFFFF'
  });
  s1.addText(
    `Autor(a): ${project.studentName}\nOrientador(a): ${project.advisorName}\n${currentYear}`,
    {
      x: 0.8,
      y: 4.8,
      w: 11.5,
      h: 1.5,
      fontSize: 16,
      color: 'E2E8F0'
    }
  );

  function addContentSlide(titleText, bullets) {
    const slide = pptx.addSlide();
    slide.background = { color: palette.lightBg };
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 13.333,
      h: 1.05,
      fill: { color: palette.primary }
    });
    slide.addText(titleText, {
      x: 0.7,
      y: 0.22,
      w: 11.9,
      h: 0.6,
      fontSize: 22,
      bold: true,
      color: 'FFFFFF'
    });
    slide.addText(
      bullets.map(item => `• ${item}`).join('\n\n'),
      {
        x: 0.8,
        y: 1.45,
        w: 11.7,
        h: 5.2,
        fontSize: 17,
        color: palette.textDark,
        valign: 'top'
      }
    );
    slide.addText(`${project.studentName} • ${parsed.course}`, {
      x: 0.8,
      y: 6.9,
      w: 11.7,
      h: 0.35,
      fontSize: 11,
      color: palette.textMuted
    });
  }

  // Slide 2: Contexto e Problema
  addContentSlide('1. Contexto e Problema de Pesquisa', [
    `Tema central: ${project.title}.`,
    'Necessidade de organizar informações, reduzir falhas e estruturar decisões com critério técnico.',
    'Problema: como alcançar maior eficiência, clareza e confiabilidade na área investigada?',
    focusNote ? `Direcionamento informado: ${focusNote}.` : 'Base estruturada para ajustes conforme o orientador.'
  ]);

  // Slide 3: Solução Proposta e Objetivos
  addContentSlide('2. Solução Proposta e Objetivos', [
    'Objetivo geral: propor e estruturar uma solução consistente para o tema investigado.',
    'Etapa 1: levantamento teórico em fontes científicas e normas técnicas (ABNT).',
    'Etapa 2: definição da solução, fluxo operacional e critérios de avaliação.',
    'Etapa 3: validação prática, revisão crítica e documentação dos resultados.'
  ]);

  // Slide 4: Metodologia e Referencial
  addContentSlide('3. Metodologia e Referencial Teórico', [
    'Pesquisa bibliográfica e documental em literatura científica e normas ABNT (NBR 14724 e NBR 6023).',
    'Apoio em autores de referência em metodologia científica (Gil; Lakatos e Marconi; Severino).',
    'Estrutura preparada para inserção de dados, métricas ou estudo de caso do aluno.',
    'Revisão contínua alinhada às diretrizes do curso e da instituição.'
  ]);

  // Slide 5: Conclusão e Próximos Passos
  addContentSlide('4. Conclusão e Próximos Passos', [
    'O modelo oferece base sólida, organizada e editável para o desenvolvimento do TCC.',
    'A definição clara do problema e da solução orienta a redação e a defesa.',
    'Próximos passos: aprofundar análises, inserir evidências próprias e validar com o(a) orientador(a).'
  ]);

  const output = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(output) ? output : Buffer.from(output);
}

module.exports = {
  initTccProjects,
  saveProject,
  generateTccDocx,
  generateTccPptx
};
