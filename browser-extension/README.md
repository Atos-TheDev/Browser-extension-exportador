# Extensão local Digisac para Exportador

Extensão Manifest V3 para Chrome e Edge. Ela não é publicada na loja e só observa cabeçalhos de requisições HTTPS de domínios Digisac suportados depois de o usuário clicar em **Capturar próxima requisição**.

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
