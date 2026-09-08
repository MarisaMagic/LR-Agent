# LR-Agent

本机把桌面端跑起来。

## 环境

- Node.js ≥ 18，npm ≥ 7
- Conda（本机 Agent / 预标注推理用）

以下命令默认在本目录执行。

## 安装前端依赖

```bash
npm install
```

## 本机 Python 环境

Electron 会自己拉起这两个服务，一般不用手开进程。

### local-agent（Agent / 标注编排）

```bash
conda create -n lr-agent-local python=3.12 -y
conda activate lr-agent-local
pip install -r vendor/local-agent/requirements.txt
```

### inference（预标注，可选）

源码在 `vendor/inference`。有 NVIDIA 显卡用 GPU 清单，否则用 CPU。

```bash
conda create -n lr-agent-inference python=3.11 -y
conda activate lr-agent-inference
pip install -r vendor/inference/requirements-gpu.txt
# 或：pip install -r vendor/inference/requirements-cpu.txt
```

## 账号后端（可选）

不做登录可以跳过。需要本机账号时，按同级 `LR-Agent-backend` 的 README 启动，或：

```bash
copy .env.example .env
```

把 `API_BASE_URL` 指到已有后端（默认 `http://localhost:8000/api/v1`）。

## 启动

```bash
npm run dev
```

dev server 已在 1212 端口时，只开窗口：

```bash
npm run dev:open
```

完整开发链（端口检查 + 编译 main + renderer）：

```bash
npm start
```

## 打本机安装包

```bash
npm run package
```
