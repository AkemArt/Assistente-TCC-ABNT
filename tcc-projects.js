const db = require('./database');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  PageBreak
} = require('docx');
const PptxGenJS = require('pptxgenjs');

let pesquisaAcademica = null;
try {
  pesquisaAcademica = require('./pesquisa-academica');
} catch (_) {
  pesquisaAcademica = null;
}

let GoogleGenAI = null;
try {
  ({ GoogleGenAI } = require('@google/genai'));
} catch (_) {
  GoogleGenAI = null;
}

async function initTccProjects() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não configurado.');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS tcc_projects (
      id BIGSERIAL PRIMARY KEY,
      discord_user_id VARCHAR(32) NOT NULL,
      discord_username VARCHAR(100) NOT NULL,
      guild_id VARCHAR(64),
      student_name VARCHAR(150) NOT NULL,
      advisor_name VARCHAR(150) NOT NULL,
      institution_course VARCHAR(200) NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      page_count VARCHAR(80) NOT NULL DEFAULT '10',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE tcc_projects ADD COLUMN IF NOT EXISTS discord_user_id VARCHAR(32);
    ALTER TABLE tcc_projects ADD COLUMN IF NOT EXISTS discord_username VARCHAR(100);
    ALTER TABLE tcc_projects ADD COLUMN IF NOT EXISTS guild_id VARCHAR(64);
    ALTER TABLE tcc_projects ADD COLUMN IF NOT EXISTS student_name VARCHAR(150);
    ALTER TABLE tcc_projects ADD COLUMN IF NOT EXISTS advisor_name VARCHAR(150);
    ALTER TABLE tcc_projects ADD COLUMN IF NOT EXISTS institution_course VARCHAR(200);
    ALTER TABLE tcc_projects ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE tcc_projects ADD COLUMN IF NOT EXISTS page_count VARCHAR(80);
    ALTER TABLE tcc_projects ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  console.log('📚 Tabela de projetos de TCC (tcc_projects) verificada.');
}

async function saveProject(project) {
  const institutionCourse =
    project.courseAndInstitution ||
    [project.course, project.institution].filter(Boolean).join(' - ') ||
    'Curso / Instituição';

  const res = await db.query(
    `INSERT INTO tcc_projects
      (discord_user_id, discord_username, guild_id, student_name, advisor_name, institution_course, title, page_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at`,
    [
      String(project.userId),
      String(project.username || 'aluno').slice(0, 100),
      project.guildId ? String(project.guildId) : null,
      String(project.studentName).slice(0, 150),
      String(project.advisorName).slice(0, 150),
      String(institutionCourse).slice(0, 200),
      String(project.title).slice(0, 1000),
      String(project.pageCount || project.focusNote || '10').slice(0, 80)
    ]
  );

  return res.rows[0];
}

function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== 'object') return '';
  const pairs = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        pairs.push([pos, word]);
      }
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.map(p => p[1]).join(' ').trim();
}

async function fetchRealArticles(project) {
  const queryText = `${project.title} ${project.courseAndInstitution || project.course || ''}`.trim();

  if (pesquisaAcademica) {
    const fn =
      pesquisaAcademica.buscarArtigos ||
      pesquisaAcademica.pesquisarArtigos ||
      pesquisaAcademica.buscarTrabalhos ||
      pesquisaAcademica.pesquisar;
    if (typeof fn === 'function') {
      try {
        const res = await fn({ tema: project.title, curso: project.course || project.courseAndInstitution || '', limite: 6 });
        const list = Array.isArray(res) ? res : (res?.artigos || res?.fontes || res?.results || []);
        if (list.length > 0) {
          return list.slice(0, 6).map(item => ({
            title: item.title || item.titulo || 'Artigo científico',
            authors: Array.isArray(item.authors || item.autores)
              ? (item.authors || item.autores).map(a => (typeof a === 'string' ? a : a.name)).filter(Boolean)
              : [item.author || item.autor].filter(Boolean),
            year: item.year || item.ano || item.publication_year || 's.d.',
            venue: item.venue || item.journal || item.revista || 'Periódico científico',
            doiOrUrl: item.doi || item.url || item.link || '',
            abstract: item.abstract || item.resumo || ''
          }));
        }
      } catch (err) {
        console.warn('⚠️ Falha no módulo pesquisa-academica, tentando OpenAlex direto:', err?.message || err);
      }
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(queryText)}&per-page=6`;
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) return [];

    const data = await resp.json();
    const works = Array.isArray(data?.results) ? data.results : [];
    return works.map(w => {
      const authors = Array.isArray(w.authorships)
        ? w.authorships.map(a => a?.author?.display_name).filter(Boolean).slice(0, 4)
        : [];
      const abstract = reconstructAbstract(w.abstract_inverted_index);
      const venue = w.primary_location?.source?.display_name || 'Base OpenAlex';
      const doiOrUrl = w.doi || w.primary_location?.landing_page_url || '';
      return {
        title: w.title || 'Trabalho acadêmico',
        authors,
        year: w.publication_year || 's.d.',
        venue,
        doiOrUrl,
        abstract: abstract.slice(0, 500)
      };
    });
  } catch (err) {
    console.warn('⚠️ Não foi possível consultar a OpenAlex:', err?.message || err);
    return [];
  }
}

function getThemePalette(project) {
  const text = `${project.title || ''} ${project.courseAndInstitution || ''}`.toLowerCase();
  if (text.includes('finan') || text.includes('econ') || text.includes('contab') || text.includes('invest')) {
    return { primary: '14532D', secondary: '166534', accent: 'CA8A04', label: 'Finanças e Economia' };
  }
  if (text.includes('ambient') || text.includes('sustent') || text.includes('clima') || text.includes('ecolog')) {
    return { primary: '065F46', secondary: '047857', accent: '0D9488', label: 'Meio Ambiente e Sustentabilidade' };
  }
  if (text.includes('saud') || text.includes('med') || text.includes('enferm') || text.includes('psic')) {
    return { primary: '0F4C81', secondary: '1D4ED8', accent: '0284C7', label: 'Saúde e Ciências Humanas' };
  }
  return { primary: '1E293B', secondary: '334155', accent: '2563EB', label: 'Tecnologia e Análise Aplicada' };
}

function buildFallbackContent(project, articles) {
  const title = project.title;
  const course = project.courseAndInstitution || project.course || 'o curso';
  const advisor = project.advisorName;
  const student = project.studentName;
  const pages = project.pageCount || '10';

  const articleSummary = articles.length
    ? articles
        .slice(0, 3)
        .map(a => `${a.authors.join(', ') || 'Autoria não informada'} (${a.year}) investigou "${a.title}" em ${a.venue}.`)
        .join(' ')
    : `A literatura especializada em ${course} aponta a necessidade de alinhar modelos analíticos e evidências empíricas ao contexto específico de "${title}".`;

  const refs = articles.length
    ? articles.map(a => {
        const aut = a.authors.length ? a.authors.join('; ').toUpperCase() : 'AUTOR DESCONHECIDO';
        return `${aut}. ${a.title}. ${a.venue}, ${a.year}.${a.doiOrUrl ? ` Disponível em: ${a.doiOrUrl}.` : ''}`;
      })
    : [
        'ASSOCIAÇÃO BRASILEIRA DE NORMAS TÉCNICAS. NBR 14724: informação e documentação — trabalhos acadêmicos — apresentação. Rio de Janeiro: ABNT, 2011.',
        'ASSOCIAÇÃO BRASILEIRA DE NORMAS TÉCNICAS. NBR 6023: informação e documentação — referências — elaboração. Rio de Janeiro: ABNT, 2018.'
      ];

  return {
    introducao: [
      `Este trabalho investiga "${title}" no âmbito de ${course}, sob orientação de ${advisor}, com estrutura planejada para cerca de ${pages} páginas.`,
      `Ao tratar de "${title}", busca-se examinar como fundamentos teóricos, dados confiáveis e critérios de decisão se articulam na prática profissional contemporânea.`,
      `Problema de pesquisa: de que maneira os conceitos e evidências associados a "${title}" podem ser aplicados de forma rigorosa e verificável para resolver desafios concretos da área?`,
      `Proposta de solução: construir um percurso analítico estruturado em levantamento bibliográfico específico, definição de critérios de avaliação e aplicação orientada ao cenário do estudo.`
    ],
    objetivos: [
      `Objetivo geral: analisar "${title}" à luz de estudos científicos e referências pertinentes ao tema, apresentando uma abordagem fundamentada para o problema investigado.`,
      `Objetivos específicos: (a) mapear estudos e conceitos centrais relacionados a "${title}"; (b) identificar entraves práticos e limitações recorrentes na área; (c) propor diretrizes aplicáveis ao contexto investigado; e (d) sintetizar conclusões e recomendações para pesquisas futuras.`
    ],
    fundamentacaoMetodologia: [
      `A fundamentação teórica sobre "${title}" apoia-se em estudos publicados e na análise crítica das abordagens aplicadas ao tema. ${articleSummary}`,
      `Para conferir consistência argumentativa, citações e referências devem dialogar diretamente com o domínio específico do trabalho — seja em finanças, sustentabilidade ambiental, gestão ou tecnologia — evitando generalizações desconectadas do objeto de estudo.`,
      `Metodologicamente, o estudo adota abordagem qualitativa e analítica com base em revisão bibliográfica direcionada e exame crítico de fontes científicas, cabendo ao autor (${student}) complementar com dados próprios e validação junto a ${advisor}.`
    ],
    conclusao: [
      `Os elementos reunidos sobre "${title}" demonstram que a solidez de um TCC depende da aderência entre o problema delimitado, as evidências científicas consultadas e a clareza da argumentação.`,
      `Recomenda-se que ${student} aprofunde a análise crítica das fontes recuperadas e valide os encaminhamentos finais com ${advisor} antes da entrega definitiva.`
    ],
    referencias: refs
  };
}

async function generateAcademicBodyWithAI(project, articles) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!GoogleGenAI || !apiKey) {
    return buildFallbackContent(project, articles);
  }

  const ai = new GoogleGenAI({ apiKey });
  const articlesText = articles.length
    ? articles
        .map(
          (a, i) =>
            `[${i + 1}] Título: ${a.title} | Autores: ${a.authors.join(', ') || 'N/I'} | Ano: ${a.year} | Fonte: ${a.venue} | Link/DOI: ${a.doiOrUrl || 'N/I'} | Resumo: ${a.abstract || 'Sem resumo disponível'}`
        )
        .join('\n')
    : 'Nenhum artigo externo retornado nesta consulta; utilize apenas referências reais consolidadas do domínio do tema e normas técnicas.';

  const prompt = `Você é um redator acadêmico rigoroso em língua portuguesa.
Redija o conteúdo específico e NÃO padronizado para um trabalho acadêmico com os seguintes dados:
- Aluno(a): ${project.studentName}
- Curso / Instituição: ${project.courseAndInstitution || project.course || 'Não informado'}
- Orientador(a): ${project.advisorName}
- Tema / Título: ${project.title}
- Quantidade de páginas desejada: ${project.pageCount || '10'}

Artigos reais recuperados na pesquisa:
${articlesText}

Regras obrigatórias:
1. Escreva texto original, fluido e específico para o tema "${project.title}". NUNCA use frases genéricas repetitivas como "No desdobramento de... (etapa 1)".
2. Use citações e menções a estudiosos, pesquisadores ou figuras reconhecidas que façam sentido direto para o tema específico (por exemplo, teóricos/pesquisadores de finanças ou economia quando o tema for finanças; cientistas ou lideranças ambientais quando o tema for meio ambiente; autores da área técnica quando o tema for computação/IA). Nunca invente citações falsas nem artigos fictícios.
3. Priorize os artigos reais listados acima na fundamentação e na lista de referências.
4. Responda APENAS em JSON válido com exatamente estas chaves:
{
  "introducao": ["parágrafo 1", "parágrafo 2", "..."],
  "objetivos": ["parágrafo objetivo geral", "parágrafo objetivos específicos"],
  "fundamentacaoMetodologia": ["parágrafo 1", "parágrafo 2", "..."],
  "conclusao": ["parágrafo 1", "parágrafo 2"],
  "referencias": ["referência 1", "referência 2"]
}`;

  try {
    const modelName = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const response = await ai.models.generateContent({
      model: modelName,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.45
      }
    });

    const rawText = (response?.text || '').trim();
    const cleanJson = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleanJson);

    if (
      Array.isArray(parsed.introducao) &&
      Array.isArray(parsed.objetivos) &&
      Array.isArray(parsed.fundamentacaoMetodologia) &&
      Array.isArray(parsed.conclusao) &&
      Array.isArray(parsed.referencias)
    ) {
      return parsed;
    }
  } catch (err) {
    console.warn('⚠️ Falha na geração por IA do corpo do TCC, usando redação adaptativa:', err?.message || err);
  }

  return buildFallbackContent(project, articles);
}

function abntParagraph(text, { bold = false, align = AlignmentType.JUSTIFIED, firstLineIndent = 708, spaceAfter = 120 } = {}) {
  return new Paragraph({
    alignment: align,
    indent: firstLineIndent ? { firstLine: firstLineIndent } : undefined,
    spacing: { line: 360, after: spaceAfter },
    children: [
      new TextRun({
        text: String(text),
        font: 'Times New Roman',
        size: 24,
        bold
      })
    ]
  });
}

function sectionHeading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    alignment: AlignmentType.LEFT,
    spacing: { before: 240, after: 140, line: 360 },
    children: [
      new TextRun({
        text: String(text).toUpperCase(),
        font: 'Times New Roman',
        size: 24,
        bold: true
      })
    ]
  });
}

async function generateTccDocx(project) {
  const institutionCourse = project.courseAndInstitution || project.course || 'CURSO E INSTITUIÇÃO';
  const articles = await fetchRealArticles(project);
  const content = await generateAcademicBodyWithAI(project, articles);

  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [new TextRun({ text: institutionCourse.toUpperCase(), font: 'Times New Roman', size: 24, bold: true })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 800, after: 400 },
      children: [new TextRun({ text: String(project.studentName).toUpperCase(), font: 'Times New Roman', size: 24, bold: true })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1200, after: 1600 },
      children: [new TextRun({ text: String(project.title).toUpperCase(), font: 'Times New Roman', size: 28, bold: true })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1400 },
      children: [new TextRun({ text: 'CARAGUATATUBA — 2026', font: 'Times New Roman', size: 24, bold: true })]
    }),
    new Paragraph({ children: [new PageBreak()] }),

    sectionHeading('1 Introdução, Problema e Proposta de Solução'),
    ...content.introducao.map(p => abntParagraph(p)),

    sectionHeading('2 Objetivos'),
    ...content.objetivos.map(p => abntParagraph(p)),

    sectionHeading('3 Fundamentação Teórica e Metodologia'),
    ...content.fundamentacaoMetodologia.map(p => abntParagraph(p)),

    sectionHeading('4 Conclusão'),
    ...content.conclusao.map(p => abntParagraph(p)),

    sectionHeading('Referências'),
    ...content.referencias.map(ref =>
      abntParagraph(ref, { align: AlignmentType.LEFT, firstLineIndent: 0, spaceAfter: 180 })
    )
  ];

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1701,
              left: 1701,
              bottom: 1134,
              right: 1134
            }
          }
        },
        children
      }
    ]
  });

  return Packer.toBuffer(doc);
}

async function generateTccPptx(project) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  const palette = getThemePalette(project);
  const institutionCourse = project.courseAndInstitution || project.course || 'Trabalho Acadêmico';

  const s1 = pptx.addSlide();
  s1.background = { color: palette.primary };
  s1.addText(palette.label.toUpperCase(), {
    x: 0.8, y: 0.7, w: 11.5, h: 0.4,
    fontSize: 13, bold: true, color: 'E2E8F0'
  });
  s1.addText(String(project.title), {
    x: 0.8, y: 1.5, w: 11.5, h: 2.2,
    fontSize: 28, bold: true, color: 'FFFFFF'
  });
  s1.addText(`Autor(a): ${project.studentName}   |   Orientador(a): ${project.advisorName}`, {
    x: 0.8, y: 4.3, w: 11.5, h: 0.5,
    fontSize: 15, color: 'F8FAFC'
  });
  s1.addText(`${institutionCourse} • ${project.pageCount || '10'} páginas`, {
    x: 0.8, y: 4.9, w: 11.5, h: 0.4,
    fontSize: 13, color: 'CBD5E1'
  });

  const slidesData = [
    {
      heading: 'Contexto e Problema de Pesquisa',
      body: `Investigação focada em "${project.title}" no contexto de ${institutionCourse}, buscando compreender os fatores determinantes, lacunas práticas e evidências científicas que orientam decisões consistentes na área.`
    },
    {
      heading: 'Objetivos e Abordagem Metodológica',
      body: `Analisar "${project.title}" com base em fontes científicas e literatura especializada, estruturando a discussão de forma crítica e verificável sob orientação de ${project.advisorName}.`
    },
    {
      heading: 'Síntese e Próximos Passos',
      body: `Revisar as fontes recuperadas, aprofundar a análise específica do tema e validar a versão final com ${project.advisorName} e os critérios acadêmicos da instituição.`
    }
  ];

  for (const item of slidesData) {
    const slide = pptx.addSlide();
    slide.background = { color: 'F8FAFC' };
    slide.addText(item.heading, {
      x: 0.7, y: 0.6, w: 12, h: 0.6,
      fontSize: 24, bold: true, color: palette.primary
    });
    slide.addText(item.body, {
      x: 0.7, y: 1.5, w: 12, h: 3.8,
      fontSize: 17, color: '1E293B', valign: 'top'
    });
  }

  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = {
  initTccProjects,
  saveProject,
  generateTccDocx,
  generateTccPptx
};
