# PDF Workflow API

A free, hostable REST API backend for testing PDF upload, search, signing, and Drive upload workflows.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | No | Health check + endpoint list |
| POST | `/auth/login` | No | Login → JWT token |
| POST | `/pdf/upload` | Yes | Upload a PDF (form-data) |
| GET | `/pdf/list` | Yes | List uploaded PDFs |
| GET | `/pdf/:id/preview` | Yes | Preview PDF metadata + text |
| POST | `/pdf/:id/search` | Yes | Search text in PDF |
| POST | `/pdf/:id/sign` | Yes | Sign the PDF |
| GET | `/pdf/signed/list` | Yes | List all signed PDFs |
| GET | `/pdf/signed/:id/download` | Yes | Download signed PDF |
| POST | `/pdf/signed/:id/drive-upload` | Yes | Upload signed PDF to Drive |
| GET | `/pdf/:id/download` | Yes | Download original PDF |

## Credentials

- Username: `admin`
- Password: `admin`

## Deploy to Render.com (Free)

1. Push this folder to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Render auto-detects `render.yaml` — click **Deploy**
5. Your URL: `https://pdf-workflow-api.onrender.com`

> ⚠️ Free tier spins down after 15 min inactivity. First request after sleep takes ~30s.

## Local Dev

```bash
cp .env.example .env
npm install
npm start
```
