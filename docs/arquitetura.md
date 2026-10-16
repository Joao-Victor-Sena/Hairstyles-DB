# Arquitetura

O frontend está em `assets/` e é servido pelo Express em desenvolvimento e pela CDN da Vercel em produção. A API fica em `src/server.js`, com as rotas de catálogo, autenticação, perfil e agendamentos. Na Vercel ela roda como função serverless (`api/index.js`).

Os dados ficam no Supabase (PostgreSQL). O esquema é versionado em `supabase/migrations/`:

1. **Schema inicial:** clientes (`profiles`, `client_addresses`), catálogo (`services`, `service_packages`), agenda (`professionals`, `time_off`, `bookings`, `booking_services`), regras de agendamento e papéis da equipe (`user_roles`).
2. **Segurança:** restrições de validação (CHECK) em todas as tabelas e views que expõem só as colunas necessárias. As tabelas ficam fechadas para as chaves públicas: o site lê apenas views (`v_services`, `v_my_profile`, `v_my_bookings`...) e escreve apenas por funções (`create_booking`, `cancel_booking`...). O CPF só aparece mascarado.
3. **Horários fixos:** `slot_times` define os horários do dia; cada horário comporta um atendimento por profissional (restrição `EXCLUDE` contra conflitos).

O login e a recuperação de senha usam o Supabase Auth. O navegador guarda o token da sessão e o envia no cabeçalho `Authorization`; o servidor repassa esse token ao Supabase, então as regras de acesso do banco valem para cada cliente.

As validações essenciais são repetidas no servidor e no banco. Preços, totais e disponibilidade nunca são aceitos do navegador: `create_booking` consulta o catálogo e os horários livres antes de gravar. Uma reserva pode ter vários serviços, e preço, nome e duração de cada um ficam congelados em `booking_services`.

A limitação de requisições usa `express-rate-limit`, com limite mais baixo nas rotas de autenticação. Erros de produção retornam mensagens genéricas, sem stack trace ou segredos. A chave `service_role` é usada só no servidor, no cadastro e na redefinição de senha.
