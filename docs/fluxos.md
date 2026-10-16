# Fluxos principais

- Visitante: Início -> catálogo -> login -> cadastro.
- Cliente: login -> seleção de um ou mais serviços -> data -> horário -> revisão -> confirmação.
- Perfil: exige token de sessão válido e redireciona para login quando ausente. Os dados cadastrais são somente leitura e o CPF aparece mascarado.

## Recuperação de senha

1. A cliente informa o e-mail em `recuperar-senha.html`. A resposta é sempre genérica, para não revelar se o e-mail existe.
2. O Supabase envia um link para `redefinir-senha.html`.
3. A cliente define a nova senha e o servidor a grava. O token do link vale por tempo limitado.

O envio depende do SMTP configurado no painel do Supabase (Authentication > SMTP Settings).
