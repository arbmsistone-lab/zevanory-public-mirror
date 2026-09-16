# ZEVANORY Break-Glass 2-of-3

Objetivo: recuperar publicação e controle sem depender de um único fornecedor ou credencial.

Regra: nenhuma credencial real, token, chave privada ou segredo pode ser armazenado neste repositório.

Custódias independentes exigidas:
1. cofre do provedor A;
2. cofre do provedor B;
3. custódia offline controlada pelo proprietário.

Para recuperação crítica, duas das três custódias devem estar disponíveis. Uma única custódia nunca é suficiente para declarar recovery-ready.

Procedimento de emergência:
- validar identidade do operador;
- reconstruir artefato público pelo survival bundle certificado;
- validar SHA-256;
- restaurar DNS a partir do snapshot público assinado por hash;
- publicar em um host alternativo;
- somente depois rotacionar credenciais comprometidas;
- vendas permanecem fail-closed até nova auditoria.

Proibido: inserir valores reais neste arquivo, em issues, logs, commits ou artefatos públicos.
