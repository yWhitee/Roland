# Importar JSON no Embed Builder

Disponível em `/embed`, `/createverify` (tipo `custom`) e `/ticketcreate`.

1. Abra o editor com um desses comandos.
2. Clique em **Import JSON** e anexe um arquivo `.json`.
3. O editor é preenchido com o conteúdo do arquivo. Nada é enviado.
4. Revise, edite com os botões normais e clique em **Send**.

A importação substitui tudo o que estava no editor. Campos ausentes ficam vazios, como depois de **Clear**.

## Arquivo

- Extensão `.json`, texto UTF-8, até 64 KB, um arquivo por vez.
- Precisa ser um objeto JSON válido.
- Propriedades desconhecidas são rejeitadas, com o caminho exato (ex.: `embed.fields[2].foo`).
- `null` ou ausente significa "não definido". Textos são aparados (`trim`).

## Schema

| Propriedade | Tipo | Limite |
| --- | --- | --- |
| `content` | texto | 2000 caracteres (mensagem fora do embed) |
| `embed.title` | texto | 256 |
| `embed.url` | URL | exige `title` |
| `embed.description` | texto | 4000 |
| `embed.color` | `"#RRGGBB"`, `"RRGGBB"` ou número 0–16777215 | |
| `embed.timestamp` | `true` / `false` | horário do envio |
| `embed.author.name` | texto | 256 |
| `embed.author.url` | URL | exige `author.name` |
| `embed.author.iconURL` | URL | exige `author.name` |
| `embed.thumbnail` | URL | |
| `embed.image` | URL | |
| `embed.footer.text` | texto | 2048 |
| `embed.footer.iconURL` | URL | exige `footer.text` |
| `embed.fields` | lista | até 25 |
| `embed.fields[].name` | texto | obrigatório, 256 |
| `embed.fields[].value` | texto | obrigatório, 1024 |
| `embed.fields[].inline` | `true` / `false` | padrão `false` |

- URLs: `http://` ou `https://`, até 2000 caracteres. O Roland não acessa essas URLs ao importar.
- O embed inteiro não pode passar de 6000 caracteres (limite do Discord).
- O embed não pode ficar vazio: precisa de título, descrição, field, autor, footer ou imagem.

## Não suportado

- `buttons` e `components`: o editor não cria botões. `/createverify` e `/ticketcreate` adicionam o próprio botão (Verify with Roblox / Open Ticket), que não pode ser alterado pelo JSON.
- `embeds` (lista): só um embed por mensagem. Use `embed`.
- Formato bruto da API do Discord (`icon_url`, `thumbnail: { "url": ... }`, `timestamp` em ISO). Use os nomes desta página.
- Imagens anexadas (`attachment://`).

## Exemplo

Veja [`embed-example.json`](embed-example.json):

```json
{
  "content": "Mensagem fora do embed (opcional)",
  "embed": {
    "title": "Título",
    "url": "https://example.com",
    "description": "Descrição com **markdown** do Discord.",
    "color": "#5865F2",
    "timestamp": true,
    "author": { "name": "Autor", "url": "https://example.com", "iconURL": "https://example.com/author.png" },
    "thumbnail": "https://example.com/thumbnail.png",
    "image": "https://example.com/image.png",
    "footer": { "text": "Footer", "iconURL": "https://example.com/footer.png" },
    "fields": [
      { "name": "Campo 1", "value": "Valor 1", "inline": true },
      { "name": "Campo 2", "value": "Valor 2", "inline": true },
      { "name": "Campo 3", "value": "Valor 3" }
    ]
  }
}
```

Mínimo:

```json
{ "embed": { "title": "Olá" } }
```
