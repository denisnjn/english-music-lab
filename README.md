# English Music Lab

Site pessoal para estudar inglês com músicas: o vídeo toca direto do YouTube, e a letra aparece em três linhas (inglês, pronúncia aproximada e tradução), com blocos de sentido coloridos e destaque palavra por palavra.

## Como usar
1. **+ Adicionar música**: cole o link do YouTube e escolha o arquivo JSON da letra (ou cole o conteúdo). Título e artista vêm do `metadata` e podem ser editados.
2. A música vai para a **Biblioteca**. Ao abrir de novo, a letra, o ajuste de sincronia, a velocidade e a pausa entre repetições já estão como você deixou.
3. **Sincronização entre PC e tablet** (opcional): clique em “Só neste aparelho” no topo e cole um token do GitHub com a permissão `gist`. As músicas ficam num Gist **privado** seu (`english-music-lab.json` + um arquivo por música). Use o mesmo token nos dois aparelhos.
4. **Backup**: o mesmo painel exporta e importa um arquivo com toda a biblioteca.

## Atalhos (PC)
| Tecla | Ação |
|---|---|
| espaço | tocar / pausar |
| ← → | frase anterior / próxima |
| R | recomeçar a frase atual |
| L | repetir a frase atual em loop |
| T | loop de trecho (toque na 1ª e na última frase) |
| ↑ ↓ | velocidade |
| [ ] | ajuste geral ±0,1 s |
| { } | ajuste geral ±0,5 s |

## Sincronização da letra
- **Ajuste geral** (por música): `+` quando a letra está atrasada em relação à voz, `−` quando está adiantada.
- **Corrigir só uma frase**: desloca apenas aquela frase (com as palavras e os blocos dela). As frases corrigidas ficam marcadas com • na letra.
- O site nunca cria tempos: tudo vem do JSON, mais os deslocamentos que você escolher.

## Formato do JSON
```json
{
  "metadata": { "title": "...", "artist": "...", "duration_ms": 0 },
  "lines": [
    {
      "i": 0,
      "text": "frase em inglês",
      "start_ms": 0, "end_ms": 0,
      "words":  [ { "text": "palavra ", "start_ms": 0, "end_ms": 0 } ],
      "chunks": [ { "en": "bloco", "pron": "pronúncia", "pt": "tradução", "start_ms": 0, "end_ms": 0 } ],
      "ptOrder": [0, 1],
      "ipa": "(opcional)",
      "note": "(opcional) dica de pronúncia"
    }
  ]
}
```
- `chunks` alternam entre azul e laranja; o mesmo bloco tem a mesma cor nas três linhas.
- `ptOrder` é a ordem dos blocos na tradução. Se faltar ou estiver inválido, usa a ordem original.
- Cada palavra é ligada ao seu bloco pelo texto; se os textos não baterem, pelo tempo.
- Bloco sem `start_ms`/`end_ms` usa os tempos das suas palavras.

## Hospedagem
Site estático (`index.html`, `styles.css`, `app.js`), sem build. Publicado pelo GitHub Pages a partir da branch `main`, pasta raiz.
