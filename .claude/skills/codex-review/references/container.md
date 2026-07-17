# コンテナ（devcontainer）で使う

このスキルはホストで動かすのがいちばん簡単で、それで足りることも多い。
コンテナはアプリを動かす場所であって、レビューはコードを読む作業なので、
**ホストからリポジトリを見てレビューすれば、コンテナに何も足さずに済む。**

それでもコンテナ内の Claude から使いたい場合の手順。

## 何が足りなくなるか

コンテナに入ると `homedir()` が変わる（例: `/home/node`）。ホストの `~/.claude` や
`~/.codex` はそこには無いので、既定では次が全部欠ける。

| 必要なもの | 既定のコンテナ | 対処 |
| --- | --- | --- |
| スキル本体 | 無い | mount するかコピーする |
| codex CLI | 無い | `npm i -g @openai/codex`（`doctor.js --fix` が実行できる） |
| **認証** (`~/.codex/auth.json`) | 無い | **自動化できない**（後述） |
| 設定 (`codex-review.config.json`) | 無い | `setup-auto.js`がCodex本体設定の継承で作る |
| 自動レビューhook | 無い | 対象リポジトリで`setup-auto.js`を実行する |

まず `node scripts/doctor.js` を実行すれば、この表のどれが欠けているかが分かる。

## 認証だけは自動化できない

`codex login` はブラウザを開く対話フローで、コンテナからは完結しない。
道は 3 つあり、**どれを選ぶかは利用者が決めること**（スキルが勝手に選ばない）。

### 1. ホストの `~/.codex` を mount する（最も手間がない）

```jsonc
// devcontainer.json
"mounts": [
  "source=${localEnv:HOME}${localEnv:USERPROFILE}/.codex,target=/home/node/.codex,type=bind"
],
"containerEnv": { "CODEX_HOME": "/home/node/.codex" }
```

`CODEX_HOME` は認証の場所も決めるので、これでホストのログインをそのまま使える。

**トレードオフ**: コンテナ内のプロセスがホストの認証トークンを読める状態になる。
`auth.json` には ChatGPT の `access_token` / `refresh_token` が入っている。
そのコンテナで動かすものすべてを信頼できる場合にだけ選ぶこと。
`readonly` を付けてもトークンは読めるので、閲覧の防止にはならない。

### 2. コンテナ内で対話ログインする

```bash
codex login
```

ブラウザのコールバックを受けるため、ポート転送が要る。認証はコンテナに残るので、
**リビルドすると消えて再ログインになる**。`~/.codex` を名前付きボリュームにすれば残せる。

### 3. API キーを使う（API 課金の場合）

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

ChatGPT プラン（Pro/Max）のサブスクリプションでは使えない。API 課金の契約が要る。
キーは devcontainer の `containerEnv` に直接書かず、ホストの環境変数から渡すこと。

## スキル本体を入れる

```jsonc
"mounts": [
  "source=${localEnv:HOME}${localEnv:USERPROFILE}/.claude/skills,target=/home/node/.claude/skills,type=bind,readonly"
]
```

`postStartCommand` でコピーする方式でもよい（ホストを書き換える事故がない分そちらが安全）。

## 判断の目安

- **ホストで回せるなら、ホストで回す。** 追加設定がゼロで、認証情報も動かさない
- コンテナ内でしか動かせない事情があるなら、認証の渡し方を上の 3 つから選ぶ
- **リビルドのたびに消えていい**なら 2（対話ログイン）が最も安全。
  毎回ログインが面倒なら 1 を選ぶが、トークンをコンテナへ渡す判断を伴う
