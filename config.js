// ================== CONFIGURAÇÃO DO PAINEL ==================
// Edite só este arquivo.
window.CONFIG = {
  // Client ID de OAuth (Google Cloud > APIs e serviços > Credenciais > ID do cliente OAuth > Aplicativo da Web)
  CLIENT_ID: 'COLE_AQUI_SEU_CLIENT_ID.apps.googleusercontent.com',

  // Projeto que paga a query no BigQuery
  PROJETO_BQ: 'meli-bi-data',

  // Planilha que guarda os dados, as tratativas e o controle (ID que fica no link /d/<ID>/edit)
  SPREADSHEET_ID: '1_1l-pzZl9lvIKkbHLkRwHQ7nIIPBVVOCJ3AnhQKLujk',

  // Abas da planilha (são criadas sozinhas se não existirem, menos a de nomes)
  ABA_DADOS: 'Dados Painel',
  ABA_TRATADOS: 'Tratados',
  ABA_CONTROLE: 'Controle Painel',
  ABA_NOMES: 'User/Name',          // A = LDAP, B = Nome

  // Domínio da conta Google aceita no login
  DOMINIO: 'mercadolivre.com',

  // Intervalos
  AUTO_MINUTOS: 5,                 // atualização automática (enquanto houver um painel aberto)
  SYNC_SEGUNDOS: 10                // leitura das tratativas dos outros PCs
};
