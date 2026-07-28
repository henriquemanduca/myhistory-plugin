# Histórico de versões para arquivos `.md`

> **Status: implementado.** Este documento é o registro do desenho original,
> escrito quando o plugin ainda era o MySync. O plugin virou o MyHistory,
> local por definição, e o CouchDB saiu do escopo. As decisões que estavam
> pendentes no fim do documento foram fechadas assim:
>
> - **Banco:** um único banco local, `myhistory-<vault-id>`. Sem replicação.
> - **Renomeação:** identidade contínua desde o MVP, via `fileId` persistente e
>   um índice `path:<caminho>`. Renomear não cria versão; o registro da nota
>   guarda o histórico de caminhos.
> - **Retenção:** últimas 50 versões por nota, configurável, com `0` para manter
>   tudo e versões fixadas isentas de expiração.
> - **Conteúdo antigo reaparecendo:** gera novo evento, como recomendado.
> - **Replicação:** não existe. O histórico é apenas local.
> - **Pré-visualização:** painel lateral com a timeline da nota ativa e um modal
>   de pré-visualização onde a restauração é confirmada. Sem diff.
>
> Um detalhe não previsto aqui apareceu na implementação: o identificador da
> versão precisa ser monotônico. Dois eventos no mesmo milissegundo com sufixo
> aleatório ordenam de forma indefinida, o que quebra a timeline e faz a
> retenção apagar a versão errada. Ver `createSequentialVersionId`.

## Objetivo

Implementar no MySync um histórico restaurável dedicado exclusivamente aos arquivos Markdown `.md` localizados dentro da pasta do vault selecionada para sincronização.

Ficam explicitamente fora do escopo:

- configurações do Obsidian;
- arquivos fora da pasta sincronizada;
- qualquer extensão diferente de `.md`;
- uso das revisões internas do PouchDB como histórico permanente.

## Situação atual

O plugin cria um documento PouchDB por caminho, usando um identificador semelhante a:

```text
vault-file:caminho/arquivo.md
```

Ao encontrar um arquivo `.md`, o código atual:

- aceita o arquivo para sincronização, pois a seleção não restringe extensões;
- classifica o arquivo como `fileType: "markdown"`;
- lê o arquivo como texto, normaliza as quebras de linha e calcula um SHA-256 em `contentHash`;
- registra caminho, nome, tamanho e datas;
- persiste o conteúdo textual no campo `content`;
- atualiza o mesmo documento quando o conteúdo muda.

Consequentemente, o documento atual de um `.md` contém o necessário para reconstruir o estado sincronizado mais recente do arquivo. O problema não é a ausência do conteúdo atual, mas a substituição desse conteúdo no mesmo documento a cada edição.

## O que as revisões atuais permitem

O código já consegue consultar as revisões folha de um documento com `open_revs: "all"` e recuperar uma revisão específica com `rev`, quando ela ainda estiver disponível. Isso é útil para:

- identificar a revisão vencedora;
- detectar versões concorrentes causadas por conflitos;
- recuperar variantes ainda ativas de um conflito;
- observar revisões de exclusão.

Essas revisões não formam um histórico confiável de edições sucessivas. Revisões internas do PouchDB/CouchDB existem para replicação e resolução de conflitos, não para versionamento permanente.

## Impossibilidades com o modelo atual

Sem alterar a implementação, não é possível:

- listar todas as edições anteriores de maneira confiável;
- garantir que o corpo de uma revisão ancestral sobreviva à compactação;
- tratar o número `_rev` como número de versão funcional do arquivo;
- distinguir uma edição real apenas pelo histórico de `_rev` após compactação;
- manter versões históricas depois que conflitos são resolvidos e suas folhas são removidas;
- replicar novos documentos de histórico sem ampliar os filtros atuais, que só reconhecem IDs de registros `vault-file:`;
- garantir atomicidade entre a atualização do documento atual e a criação de uma versão histórica usando as operações individuais existentes;
- reconstruir retroativamente versões antigas a partir apenas dos hashes já gravados.

Também não existe hoje interface, comando, política de retenção ou método de restauração para histórico.

## Possibilidades de implementação

### 1. Aproveitar o conteúdo Markdown já armazenado

O documento `vault-file:` já cumpre o papel de estado atual restaurável para `.md`. A implementação do histórico pode reutilizar `content`, `contentHash`, caminho, tamanho e datas sem mudar o armazenamento dos demais tipos de arquivo.

Essa capacidade, isoladamente, ainda não cria histórico: cada gravação substitui o estado vencedor do mesmo documento.

### 2. Criar documentos imutáveis de versão

Cada mudança de conteúdo deve criar um novo documento que nunca seja sobrescrito. Exemplo de identificador:

```text
md-history:<identidade-do-arquivo>:<timestamp-ou-uuid>
```

Estrutura inicial sugerida:

```ts
interface MarkdownHistoryRecord {
	_id: string;
	type: "md-history";
	fileId: string;
	path: string;
	fileName: string;
	content: string;
	contentHash: string;
	size: number;
	capturedAt: string;
	sourceLastChanged: number;
	event: "created" | "modified" | "deleted" | "restored";
	previousVersionId?: string;
}
```

O conteúdo deve fazer parte do documento histórico. Um hash sozinho permite comparar versões, mas não restaurá-las.

### 3. Separar identidade de caminho

Hoje a identidade do arquivo deriva do caminho. Após uma renomeação, o sistema vê outro identificador. Existem duas estratégias possíveis:

- MVP: manter o histórico agrupado por caminho e registrar explicitamente eventos de renomeação que conectem o caminho anterior ao novo;
- modelo robusto: atribuir um `fileId` persistente, independente do caminho, e usar o caminho apenas como atributo de cada versão.

Um `fileId` persistente oferece uma linha do tempo contínua depois de renomeações, mas exige migração e uma forma segura de associar o arquivo renomeado à identidade anterior.

### 4. Registrar exclusões sem apagar o histórico

Ao excluir um `.md`, deve ser criado um evento histórico `deleted`. Os documentos anteriores permanecem disponíveis. Restaurar uma versão cria novamente o arquivo no vault e registra uma nova versão com evento `restored`; não se deve alterar um documento histórico antigo.

### 5. Replicar o histórico

Os filtros de push e pull precisam reconhecer `md-history:` além de `vault-file:`. Caso contrário, o histórico existirá apenas no banco local.

Alternativas:

- mesmo banco: simplifica a replicação e a consulta, mas aumenta o volume do banco operacional;
- banco separado: por exemplo `mysync-history-<vault-id>`, oferecendo retenção e manutenção independentes, ao custo de uma segunda replicação e mais estados de erro.

Para o primeiro incremento, usar o mesmo banco tende a ser mais simples. Os documentos devem carregar `type: "md-history"` para consultas e filtros explícitos.

### 6. Listar e restaurar versões

É possível oferecer comandos como:

- `List Markdown versions for current file`;
- `Preview selected Markdown version`;
- `Restore selected Markdown version`;
- `Delete Markdown history older than the retention period`.

A listagem pode consultar os documentos pelo `fileId` e ordenar por `capturedAt`. Para evitar varrer todo o banco em vaults grandes, será necessário um índice consultável, uma chave cujo prefixo permita busca por intervalo ou o plugin `pouchdb-find`.

A restauração deve:

1. confirmar que o registro pertence a um `.md`;
2. validar o conteúdo e o hash armazenados;
3. detectar se o arquivo atual mudou desde que a interface foi aberta;
4. escrever o conteúdo pelo adapter do vault;
5. deixar o fluxo normal registrar a restauração como uma nova versão.

## Regras recomendadas

- Aplicar o histórico apenas quando `file.extension.toLowerCase() === "md"`.
- Excluir integralmente documentos com `source: "obsidian-config"`.
- Não criar versões para outros tipos de arquivo.
- Criar uma versão apenas quando `contentHash` for diferente da última versão registrada.
- Nunca usar `_rev` como identificador público de uma versão histórica.
- Nunca modificar versões históricas, exceto por uma política explícita de expiração.
- Preservar histórico após exclusão ou renomeação.
- Registrar datas em UTC no formato ISO 8601.
- Não registrar o conteúdo dos arquivos nos logs.
- Serializar captura, atualização do estado atual e restauração na fila de operações do banco.

## Consistência e duplicação

PouchDB não oferece uma transação envolvendo vários documentos pela API atualmente usada. Uma falha pode ocorrer entre salvar o estado atual e salvar a versão histórica.

Para tornar a captura repetível:

- gerar a identidade da versão de forma determinística quando possível;
- verificar a existência de uma versão com o mesmo `fileId` e `contentHash` antes de gravar;
- definir claramente se voltar de A para B e depois para A cria um novo evento ou reutiliza o conteúdo antigo;
- preferir `bulkDocs` se quisermos reduzir, mas não eliminar, a janela de inconsistência;
- executar uma reconciliação na inicialização, comparando o `.md` atual com sua última versão histórica.

Recomendação: preservar cada ocorrência na linha do tempo, inclusive quando um conteúdo antigo reaparece. Se deduplicação de armazenamento se tornar necessária, conteúdo e evento podem ser separados em documentos diferentes no futuro.

## Retenção e crescimento

Um histórico imutável cresce continuamente. Antes de liberar a funcionalidade, é necessário escolher pelo menos uma política:

- manter todas as versões;
- manter as últimas `N` versões por arquivo;
- manter versões por uma quantidade de dias;
- combinar limite por arquivo e idade;
- permitir marcar versões protegidas contra expiração.

A compactação do PouchDB não remove documentos históricos vivos. Ela recupera espaço de revisões antigas dos próprios documentos, por isso cada versão que deve sobreviver precisa continuar sendo um documento independente e não excluído.

## Migração dos dados atuais

Os registros `.md` existentes já possuem conteúdo, metadados e hash do estado atual. Eles podem originar uma versão inicial restaurável, mas não permitem reconstruir edições que já foram substituídas ou removidas por compactação.

Na primeira execução da funcionalidade, o plugin poderá:

1. localizar os registros `.md` atuais dentro da pasta sincronizada;
2. usar o conteúdo do documento PouchDB atual ou reconciliá-lo com o arquivo do vault;
3. gravar uma versão inicial marcada como `baseline`.

Essa versão inicial representa apenas o estado encontrado durante a migração. Nenhuma edição anterior poderá ser recuperada.

## MVP proposto

1. Introduzir `MarkdownHistoryRecord` como documento imutável.
2. Criar uma versão inicial para cada `.md` encontrado.
3. Criar versões em mudanças de conteúdo e exclusões.
4. Ampliar push e pull para incluir documentos `md-history:`.
5. Listar versões do `.md` selecionado, inicialmente por data e hash.
6. Permitir restauração, sempre gerando uma nova versão.
7. Implementar reconciliação após falhas ou reinicialização.
8. Definir e aplicar uma política de retenção.

## Critérios de aceite

- Um `.md` novo gera um registro atual com conteúdo e uma versão histórica restaurável.
- Alterar somente metadados sem mudar `contentHash` não gera nova versão.
- Cada mudança de conteúdo gera exatamente um novo evento visível na linha do tempo.
- Arquivos que não terminam em `.md` não geram documentos históricos.
- Configurações do Obsidian não geram documentos históricos.
- Uma versão continua restaurável após sincronização e compactação normal do banco.
- Excluir um `.md` mantém suas versões e registra a exclusão.
- Restaurar uma versão não destrói a versão atual; ela passa a integrar o histórico.
- Reiniciar o Obsidian durante uma gravação não deixa silenciosamente o estado atual sem uma versão correspondente.
- Push e pull transportam o histórico sem depender das revisões ancestrais do documento `vault-file:`.

## Decisões pendentes

- O histórico ficará no banco operacional ou em banco separado?
- Renomeações precisam preservar uma identidade contínua já no MVP?
- Qual será a política padrão de retenção?
- Voltar a um conteúdo antigo deve aparecer como novo evento? Recomendação: sim.
- O histórico será replicado por padrão ou haverá opção somente local?
- Qual será a experiência de pré-visualização e confirmação antes da restauração?

## Conclusão

O PouchDB oferece os mecanismos necessários para armazenar, consultar e replicar um histórico de arquivos `.md`, mas suas revisões internas não devem ser usadas como esse histórico. Como o conteúdo Markdown atual já é persistido, a implementação pode se concentrar em registrar cada estado relevante como documento imutável e restaurável.
