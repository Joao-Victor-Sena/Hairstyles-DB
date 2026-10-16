# Hairstyles

O Hairstyles é uma aplicação para o salão de beleza Hairstyles. Clientes podem conhecer os serviços, criar uma conta e solicitar horários de atendimento pela internet.

A aplicação foi construída com HTML, CSS, JavaScript, Node.js e Express. Os dados, o login e a recuperação de senha ficam no Supabase (PostgreSQL + Auth). As imagens da vitrine são placeholders e podem ser substituídas pelos materiais do salão.

O agendamento funciona em três etapas: seleção de um ou mais serviços, escolha de data e horário e confirmação. O total é sempre calculado no banco de dados, nunca pelo navegador. Os serviços de cada reserva ficam em `booking_services`, com nome e preço do momento da reserva.

## Configurar o Supabase (uma vez)

1. Crie um projeto em https://supabase.com.
2. No painel, abra **SQL Editor** e execute, nesta ordem, os arquivos da pasta `supabase/migrations/`:
   1. `20261012000000_schema_inicial.sql` (tabelas, serviços e preços)
   2. `20261012000100_seguranca_checks_views.sql` (validações, views e bloqueio de acesso direto às tabelas)
   3. `20261012000200_horarios_fixos.sql` (horários do dia: 09:00, 10:30, 13:30, 15:00 e 16:30)
3. Em **Project Settings > API**, copie a URL do projeto, a chave `anon` e a chave `service_role`.
4. Em **Authentication > SMTP Settings**, configure o envio de e-mails. A recuperação de senha agora é feita pelo Supabase, por link, e não usa mais o `SMTP_*` do `.env`.
5. Em **Authentication > URL Configuration**, informe o endereço do site em *Site URL* e inclua `ENDERECO_DO_SITE/redefinir-senha.html` em *Redirect URLs*.
6. Crie a conta da dona do salão pelo cadastro do site e, no SQL Editor, rode:
   `insert into public.user_roles (user_id, role) select id, 'admin' from auth.users where email = 'EMAIL_DA_DONA';`

Para mudar os horários do dia, edite a tabela `slot_times`. Para fechar um dia ou um período, use `time_off`.

## Executar

1. Instale o Node.js 20 ou superior.
2. Rode `npm install`.
3. Copie `config/env.example` para `.env` e preencha `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` e `SITE_URL`.
4. Rode `npm run db:check` para confirmar a conexão e a segurança do banco.
5. Rode `npm run dev`.
6. Abra `http://localhost:3000`.

A chave secret (`SUPABASE_SECRET_KEY`) é secreta: só vale no servidor (arquivo `.env` e variáveis da hospedagem). Nunca a coloque no navegador nem no GitHub.

## Publicação

O projeto inclui `vercel.json` e `api/index.js` para publicação na Vercel: as páginas de `assets/` saem direto da CDN e tudo em `/api/*` é atendido pelo mesmo servidor Express. O banco é externo e persistente (Supabase), então não há mais arquivo de banco local.

## Testes

`npm test` roda os testes básicos, que não precisam de internet nem do Supabase.
