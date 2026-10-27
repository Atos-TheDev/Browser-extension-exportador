# Extensão Digisac para Exportador

Extensão Manifest V3 para Chrome e Edge. Captura a URL e o bearer token Digisac somente após acionamento manual e oferece suporte aos jobs AWX iniciados pela ferramenta.

## Instalação local

1. Abra `chrome://extensions` no Chrome ou `edge://extensions` no Edge.
2. Ative **Modo do desenvolvedor**.
3. Selecione **Carregar sem compactação** e escolha esta pasta `browser-extension/`.
4. Fixe a extensão na barra do navegador, se desejar.

## Uso

1. Abra e autentique-se na conta Digisac desejada.
2. Clique no ícone da extensão e depois em **Capturar próxima requisição**.
3. Faça uma ação na página que gere uma chamada para `/api/v1/` ou recarregue a página Digisac. A extensão não consegue ler cabeçalhos de chamadas que aconteceram antes de ser ativada.
4. Quando encontrar um cabeçalho `Authorization: Bearer ...`, a extensão abre o Exportador configurado, transfere a URL base e o token sem incluí-los na URL, e valida ambos pelo fluxo normal do Exportador.

A extensão só captura requisições da aba que estava ativa quando o botão foi clicado. Use **Cancelar captura** para desarmá-la. A captura pendente e o token ficam apenas no armazenamento efêmero da sessão do navegador e são removidos após a entrega; a extensão não grava tokens em `storage.local`, cookies, logs ou URLs. O Exportador mantém sua política atual: o token só é persistido localmente quando o usuário opta por guardar a sessão e expira após uma hora sem validação. Uma captura recebida expira da memória da página após cinco minutos se ainda não tiver sido validada.

O destino é `https://exportador-digisac.atos-prado.workers.dev/`. A lista de domínios Digisac observados e o destino podem ser ajustados em `manifest.json` e `background.js` antes de carregar a extensão.

## Jobs AWX

Na ferramenta, abra **Análise de lentidão** e inicie **Buscar todos os webhooks da URL** ou **Buscar fila de processos**. A extensão abre o template AWX correspondente, clica em **Launch** e preenche o subdomínio da sessão. Ela não inicia o job: revise o formulário e inicie manualmente.

Depois que o job iniciar, a extensão acompanha o status e atualiza a aba em intervalos controlados. Ao terminar, identifica o download esperado do output, lê o TXT usando a sessão AWX já autenticada no navegador e entrega o conteúdo à janela da ferramenta que iniciou a consulta. Também renomeia apenas o download AWX esperado no mesmo padrão usado pela ferramenta, por exemplo `awx-webhooks-qa-suporte-275150.txt` ou `awx-process-queue-qa-suporte-275149.txt`. A ferramenta associa o retorno à sessão e ao job correspondentes. Se a aba AWX for fechada, a sessão do job desaparece com ela; se a página do Exportador for fechada primeiro, a extensão encerra o acompanhamento e remove o registro pendente da sessão AWX. Também é possível informar na ferramenta a URL de um job concluído para importar o output sem executar o job novamente.

O suporte AWX está limitado a `https://awx-public.ikatec.cloud/*`. A extensão não lê cookies nem tokens AWX, não envia o output a um servidor e não inclui o recurso experimental que exportava JSON da página. O output fica no fluxo entre as abas AWX e da ferramenta, correlacionado por ID de solicitação e job.

Ao atualizar a extensão, o Chrome pode pedir aprovação para as novas permissões de acesso ao AWX e de leitura dos downloads. Essa versão usa `downloads` e `scripting` para associar o TXT ao job e lê-lo dentro da página autenticada do AWX.
