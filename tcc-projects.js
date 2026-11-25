const db = require('./database');
const { gerarRascunhoComPesquisa } = require('./ia-tcc');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  PageBreak,
  ExternalHyperlink
} = require('docx');
const PptxGenJS = require('pptxgenjs');

function urlHttpsValida(valor) {
  try {
    return new URL(valor).protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizarDoi(valor) {
  return String(valor || '').replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
}

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
  // Não ignora falhas de migração: o objetivo precisa ser persistido corretamente.
  await initTccProjects();

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

  children.push(sectionHeading('REFERÊNCIAS'));
  for (let i = 0; i < (resultadoPesquisa.referencias || []).length; i += 1) {
    const referencia = resultadoPesquisa.referencias[i];
    children.push(abntParagraph(referencia, {
      align: AlignmentType.LEFT,
      firstLineIndent: 0,
      spaceAfter: 100
    }));
    const fonte = (resultadoPesquisa.fontesCitadas || resultadoPesquisa.fontes || []).find(item =>
      item.titulo && referencia.includes(item.titulo)
    );
    const urlArtigo = fonte && (fonte.urlPaginaArtigo || fonte.link ||
      (fonte.doi ? 'https://doi.org/' + normalizarDoi(fonte.doi) : null));
    if (urlArtigo && urlHttpsValida(urlArtigo)) {
      children.push(new Paragraph({
        indent: { left: 360 },
        spacing: { after: 180 },
        children: [new ExternalHyperlink({
          link: urlArtigo,
          children: [new TextRun({ text: 'Acessar artigo / página oficial', style: 'Hyperlink', font: 'Times New Roman', size: 20 })]
        })]
      }));
    }
    const pdfConsultado = fonte && (fonte.pdfUrlVerificado || fonte.pdfUrl);
    if (pdfConsultado && urlHttpsValida(pdfConsultado)) {
      children.push(new Paragraph({
        indent: { left: 360 },
        spacing: { after: 100 },
        children: [new ExternalHyperlink({
          link: pdfConsultado,
          children: [new TextRun({ text: fonte.textoCompleto ? 'Abrir PDF consultado (texto extraído)' : 'Tentar abrir PDF em acesso aberto', style: 'Hyperlink', font: 'Times New Roman', size: 20 })]
        })]
      }));
    }
    if (fonte) {
      children.push(abntParagraph(
        'Situação da consulta: ' + String(fonte.statusTextoCompleto || 'Texto integral não extraído; consultar página do artigo e resumo.'),
        { align: AlignmentType.LEFT, firstLineIndent: 0, spaceAfter: 180 }
      ));
    }
  }

  children.push(abntParagraph(
    'Nota de normalização: estas referências são preliminares e foram montadas com os metadados recuperados. Confira os dados ausentes e revise a apresentação conforme a ABNT NBR 6023:2025, a ABNT NBR 10520:2023 e o manual vigente da instituição.',
    { align: AlignmentType.JUSTIFIED, firstLineIndent: 0, spaceAfter: 240 }
  ));
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

  for (const fonte of (pesquisa?.fontesCitadas || pesquisa?.fontes || [])) {
    const slide = pptx.addSlide();
    slide.background = { color: 'F8FAFC' };
    slide.addText('Referência bibliográfica e acesso ao estudo', {
      x: 0.7, y: 0.6, w: 12, h: 0.6,
      fontSize: 23, bold: true, color: palette.primary
    });
    slide.addText(String(fonte.titulo || 'Título não informado'), {
      x: 0.8, y: 1.5, w: 11.7, h: 1.1,
      fontSize: 20, bold: true, color: '1E293B', valign: 'top', fit: 'shrink'
    });
    slide.addText(String((fonte.autores || []).join('; ') + ' (' + (fonte.ano || 's.d.') + ')'), {
      x: 0.8, y: 2.8, w: 11.7, h: 0.6,
      fontSize: 14, color: '334155', valign: 'top'
    });
    const urlArtigo = fonte.urlPaginaArtigo || fonte.link ||
      (fonte.doi ? 'https://doi.org/' + normalizarDoi(fonte.doi) : null);
    if (urlArtigo && urlHttpsValida(urlArtigo)) {
      slide.addText([{ text: 'Abrir página oficial do artigo / DOI', options: { hyperlink: { url: urlArtigo, tooltip: 'Abrir artigo ou registro DOI' }, color: '0563C1', underline: { color: '0563C1' } } }], {
        x: 0.8, y: 3.8, w: 11.7, h: 0.45, fontSize: 16
      });
    }
    const pdfConsultado = fonte.pdfUrlVerificado || fonte.pdfUrl;
    if (pdfConsultado && urlHttpsValida(pdfConsultado)) {
      slide.addText([{ text: fonte.textoCompleto ? 'Abrir PDF consultado (texto extraído)' : 'Tentar abrir PDF em acesso aberto', options: { hyperlink: { url: pdfConsultado, tooltip: 'Abrir PDF do artigo' }, color: '0563C1', underline: { color: '0563C1' } } }], {
        x: 0.8, y: 4.45, w: 11.7, h: 0.45, fontSize: 16
      });
    }
    slide.addText('Situação do texto: ' + String(fonte.statusTextoCompleto || 'Não verificada') + '\\nMetadados: ' + String(fonte.verificacaoCrossref || 'Não verificados'), {
      x: 0.8, y: 5.25, w: 11.7, h: 0.8, fontSize: 12, color: '475569', valign: 'top'
    });
  }

  const nota = pptx.addSlide();
  nota.background = { color: 'F8FAFC' };
  nota.addText('Nota sobre referências e normalização', {
    x: 0.7, y: 0.6, w: 12, h: 0.6,
    fontSize: 23, bold: true, color: palette.primary
  });
  nota.addText(
    'As referências desta apresentação são preliminares e utilizam os metadados recuperados. Confira os dados ausentes e revise a apresentação conforme a ABNT NBR 6023:2025, a ABNT NBR 10520:2023 e o manual vigente da instituição. A auditoria automatizada não substitui a leitura crítica dos artigos pelo estudante e pelo orientador.',
    {
      x: 0.8, y: 1.5, w: 11.7, h: 3.2,
      fontSize: 18, color: '334155', valign: 'top',
      breakLine: false, fit: 'shrink'
    }
  );

  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = {
  initTccProjects,
  saveProject,
  generateTccResearch,
  generateTccDocx,
  generateTccPptx
};
