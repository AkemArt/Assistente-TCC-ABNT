const db = require('./database');
const { gerarRascunhoComPesquisa } = require('./ia-tcc');
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

async function initTccProjects() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não configurado.');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS tcc_projects (
      id BIGSERIAL PRIMARY KEY,
      discord_user_id VARCHAR(32) NOT NULL DEFAULT '',
      discord_username VARCHAR(100) NOT NULL DEFAULT 'aluno',
      guild_id VARCHAR(64),
      student_name VARCHAR(150) NOT NULL DEFAULT '',
      advisor_name VARCHAR(150) NOT NULL DEFAULT '',
      institution VARCHAR(200) NOT NULL DEFAULT '',
      institution_course VARCHAR(200) NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      page_count VARCHAR(80) NOT NULL DEFAULT '10',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Migração aditiva e segura: registra o objetivo sem apagar dados existentes.
  await db.query(`
    ALTER TABLE tcc_projects
    ADD COLUMN IF NOT EXISTS objective TEXT NOT NULL DEFAULT '';
  `);

  console.log('📚 Tabela de projetos de TCC (tcc_projects) verificada.');
}

async function saveProject(project) {
  await initTccProjects().catch(() => {});

  const institutionCourse =
    project.courseAndInstitution ||
    [project.course, project.institution].filter(Boolean).join(' - ') ||
    'Curso / Instituição';
  const institutionValue = String(project.institution || institutionCourse).slice(0, 200);
  const studentName = String(project.studentName || '').slice(0, 150);
  const advisorName = String(project.advisorName || '').slice(0, 150);
  const title = String(project.title || '').slice(0, 1000);
  const pageCount = String(project.pageCount || project.focusNote || '10').slice(0, 80);
  const userId = String(project.userId || '');
  const username = String(project.username || 'aluno').slice(0, 100);
  const guildId = project.guildId ? String(project.guildId) : null;

  // Descobre as colunas reais da tabela para preencher qualquer NOT NULL sem default
  const colsRes = await db.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tcc_projects'
  `);

  const knownValues = {
    discord_user_id: userId,
    user_id: userId,
    discord_username: username,
    username,
    guild_id: guildId,
    student_name: studentName,
    aluno: studentName,
    advisor_name: advisorName,
    orientador: advisorName,
    institution: institutionValue,
    instituicao: institutionValue,
    course: institutionCourse,
    curso: institutionCourse,
    institution_course: institutionCourse,
    curso_instituicao: institutionCourse,
    title,
    titulo: title,
    tema: title,
    objective: String(project.objective || project.problem || '').slice(0, 2000),
    objetivo: String(project.objective || project.problem || '').slice(0, 2000),
    project_objective: String(project.objective || project.problem || '').slice(0, 2000),
    page_count: pageCount,
    paginas: pageCount,
    folhas: pageCount
  };

  const columnsToInsert = [];
  const params = [];

  for (const col of colsRes.rows) {
    const name = col.column_name;
    if (name === 'id' || name === 'created_at' || name === 'updated_at') continue;

    if (Object.prototype.hasOwnProperty.call(knownValues, name)) {
      const val = knownValues[name];
      if (val !== null && val !== undefined) {
        columnsToInsert.push(name);
        params.push(val);
        continue;
      }
    }

    // Se a coluna é NOT NULL e não tem default, fornece um valor seguro pelo tipo
    if (col.is_nullable === 'NO' && !col.column_default) {
      if (col.data_type.includes('int') || col.data_type.includes('numeric') || col.data_type.includes('decimal')) {
        columnsToInsert.push(name);
        params.push(0);
      } else if (col.data_type === 'boolean') {
        columnsToInsert.push(name);
        params.push(false);
      } else if (col.data_type.includes('timestamp') || col.data_type === 'date') {
        columnsToInsert.push(name);
        params.push(new Date());
      } else {
        columnsToInsert.push(name);
        params.push('');
      }
    }
  }

  if (columnsToInsert.length === 0) {
    return { id: 'sem-id' };
  }

  const placeholders = columnsToInsert.map((_, idx) => `$${idx + 1}`).join(', ');
  const sql = `
    INSERT INTO tcc_projects (${columnsToInsert.join(', ')})
    VALUES (${placeholders})
    RETURNING id
  `;

  const res = await db.query(sql, params);
  return res.rows[0] || { id: 'novo' };
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

  const modelName = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
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
      const isUnavailable = err?.status === 503 || String(err?.message || '').includes('503');
      if (isUnavailable && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      console.warn('⚠️ Falha na geração por IA do corpo do TCC, usando redação adaptativa:', err?.message || err);
    }
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

async function generateTccResearch(project) {
  return gerarRascunhoComPesquisa({
    tema: project.title,
    objetivo: project.objective || project.problem || '',
    limite: 8,
    pageCount: Number(project.pageCount) || 10
  });
}

async function generateTccDocx(project, pesquisa = null) {
  const institutionCourse = project.courseAndInstitution || project.course || 'CURSO E INSTITUIÇÃO';
  const resultadoPesquisa = pesquisa || await generateTccResearch(project);
  const secoes = resultadoPesquisa.secoes;

  const children = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [new TextRun({ text: institutionCourse.toUpperCase(), font: 'Times New Roman', size: 24, bold: true })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 800, after: 400 },
      children: [new TextRun({ text: String(project.studentName || '').toUpperCase(), font: 'Times New Roman', size: 24, bold: true })]
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1200, after: 1600 },
      children: [new TextRun({ text: String(project.title || '').toUpperCase(), font: 'Times New Roman', size: 28, bold: true })]
    }),
    ...(project.city || project.location ? [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1400 },
      children: [new TextRun({ text: String(project.city || project.location).toUpperCase(), font: 'Times New Roman', size: 24, bold: true })]
    })] : []),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200 },
      children: [new TextRun({ text: String(project.year || new Date().getFullYear()), font: 'Times New Roman', size: 24, bold: true })]
    }),
    new Paragraph({ children: [new PageBreak()] })
  ];

  const secoesDocumento = [
    ['1 INTRODUÇÃO', secoes.introducao],
    ['2 PROBLEMA DE PESQUISA', secoes.problemaPesquisa],
    ['3 OBJETIVOS', secoes.objetivos],
    ['4 FUNDAMENTAÇÃO TEÓRICA', secoes.fundamentacaoTeorica],
    ['5 METODOLOGIA', secoes.metodologia],
    ['6 DISCUSSÃO', secoes.discussao],
    ['7 CONCLUSÃO', secoes.conclusao],
    ['8 LIMITAÇÕES DAS FONTES', secoes.limitacoes],
    ['9 PONTOS PARA VERIFICAÇÃO', secoes.verificacoes]
  ];

  for (const [titulo, paragrafos] of secoesDocumento) {
    children.push(sectionHeading(titulo));
    for (const paragrafo of paragrafos || []) {
      children.push(abntParagraph(paragrafo));
    }
  }

  children.push(sectionHeading('REFERÊNCIAS PRELIMINARES'));
  for (const referencia of resultadoPesquisa.referencias || []) {
    children.push(abntParagraph(referencia, {
      align: AlignmentType.LEFT,
      firstLineIndent: 0,
      spaceAfter: 180
    }));
  }

  children.push(sectionHeading('RELATÓRIO DA PESQUISA'));
  for (const linha of String(resultadoPesquisa.relatorioPesquisa || '').split('\n').filter(Boolean)) {
    children.push(abntParagraph(linha, {
      align: AlignmentType.LEFT,
      firstLineIndent: 0,
      spaceAfter: 100
    }));
  }

  const doc = new Document({
    sections: [{
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
    }]
  });

  return Packer.toBuffer(doc);
}

async function generateTccPptx(project, pesquisa = null) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  const palette = getThemePalette(project);
  const institutionCourse = project.courseAndInstitution || project.course || 'Trabalho Acadêmico';
  const secoes = pesquisa?.secoes || {};

  const slideCapa = pptx.addSlide();
  slideCapa.background = { color: palette.primary };
  slideCapa.addText(palette.label.toUpperCase(), {
    x: 0.8, y: 0.7, w: 11.5, h: 0.4,
    fontSize: 13, bold: true, color: 'E2E8F0'
  });
  slideCapa.addText(String(project.title), {
    x: 0.8, y: 1.5, w: 11.5, h: 2.2,
    fontSize: 28, bold: true, color: 'FFFFFF'
  });
  slideCapa.addText(`Autor(a): ${project.studentName} | Orientador(a): ${project.advisorName}`, {
    x: 0.8, y: 4.3, w: 11.5, h: 0.5,
    fontSize: 15, color: 'F8FAFC'
  });
  slideCapa.addText(`${institutionCourse} • ${project.pageCount || '10'} páginas solicitadas`, {
    x: 0.8, y: 4.9, w: 11.5, h: 0.4,
    fontSize: 13, color: 'CBD5E1'
  });

  const resumoSecao = (chave) => (Array.isArray(secoes[chave]) ? secoes[chave] : []).join('\n\n');
  const slidesData = [
    { heading: 'Objetivo do projeto', body: project.objective || project.problem || 'Objetivo não informado.' },
    { heading: 'Introdução e problema de pesquisa', body: resumoSecao('introducao') + '\n\n' + resumoSecao('problemaPesquisa') },
    { heading: 'Objetivos e fundamentação teórica', body: resumoSecao('objetivos') + '\n\n' + resumoSecao('fundamentacaoTeorica') },
    { heading: 'Metodologia proposta', body: resumoSecao('metodologia') },
    { heading: 'Discussão e conclusão', body: resumoSecao('discussao') + '\n\n' + resumoSecao('conclusao') },
    { heading: 'Fontes e verificações', body: (pesquisa?.referencias || []).join('\n') + '\n\n' + (pesquisa?.relatorioPesquisa || 'Consulte os textos originais e valide as referências com o orientador.') }
  ];

  for (const item of slidesData) {
    const slide = pptx.addSlide();
    slide.background = { color: 'F8FAFC' };
    slide.addText(item.heading, {
      x: 0.7, y: 0.6, w: 12, h: 0.6,
      fontSize: 24, bold: true, color: palette.primary
    });
    slide.addText(String(item.body || 'Conteúdo a desenvolver.'), {
      x: 0.7, y: 1.35, w: 12, h: 5.4,
      fontSize: 13, color: '1E293B', valign: 'top',
      breakLine: false, paraSpaceAfterPt: 8, fit: 'shrink'
    });
  }

  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = {
  initTccProjects,
  saveProject,
  generateTccResearch,
  generateTccDocx,
  generateTccPptx
};
