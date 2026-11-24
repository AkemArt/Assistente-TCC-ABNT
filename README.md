# Assistente TCC ABNT 🤖📚

## Sobre o projeto

O **Assistente TCC ABNT** é um bot desenvolvido para o Discord com o objetivo de auxiliar estudantes na organização, elaboração e estruturação de Trabalhos de Conclusão de Curso (TCC).

O projeto reúne recursos de autenticação, geração de documentos acadêmicos e apresentação, pesquisa e apoio com inteligência artificial, avaliação dos usuários e acompanhamento de projetos.

## Funcionalidades

- **Autenticação e sessão:** cadastro (`/cadastrar`) e login (`/login`) por e-mail com senha numérica de 8 dígitos (hash criptográfico via `crypto`), encerramento via `/logout` e preferência de manter conectado (**Sim** / **Não**) por menu de múltipla escolha (`/manter_conectado`).
- **Criação e organização de projetos de TCC:** registro de dados do aluno, curso/instituição, orientador, tema/título e quantidade de folhas (`/iniciar_tcc`).
- **Geração de documentos e apresentações:** criação de arquivos **Word (.docx)** formatados na estrutura ABNT e **PowerPoint (.pptx)** temáticos para revisão.
- **Rascunho acadêmico com IA:** geração de rascunhos com apoio de inteligência artificial e busca de fontes acadêmicas (`/rascunho_tcc`).
- **Avaliação de usuários:** comando `/avaliar` com seleção de nota de **1** (*menos gostei*) a **10** (*gostei muito*) em múltipla escolha e modal para escrever **o que precisa melhorar?**.
- **Comandos administrativos e estatísticas:** consultas restritas ao administrador (`/usuarios_tcc` e `/avaliacoes_tcc`) e métricas de uso (`/estatisticas`).
- **Histórico de trabalhos (em desenvolvimento):** consulta de projetos salvos para reutilizar ou apagar do histórico.

## Tecnologias utilizadas

- **JavaScript** e **Node.js**
- **Discord.js**
- **PostgreSQL** (`tcc_users`, `tcc_avaliacoes`, `tcc_projects` e tabelas de apoio)
- **Google Gemini AI**
- **Microsoft Word (.docx)** e **PowerPoint (.pptx)**

## Documentação

Na pasta `docs`, estão disponíveis os relatórios e diagramas que apresentam a estrutura, o fluxo e a evolução do projeto.

## Status

🚧 Projeto em desenvolvimento (autenticação por e-mail + senha de 8 dígitos, menu de manter conectado e avaliação de 1 a 10 implementados; histórico de trabalhos com reutilização/exclusão em andamento).

## Autoria

Projeto desenvolvido como iniciativa de aprendizagem e aplicação prática de conhecimentos em Análise e Desenvolvimento de Sistemas.
