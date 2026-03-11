# shortlink

PulseLink is a real-time URL shortener built with plain Node.js, file-backed storage, and a responsive analytics dashboard.

## Features

- Create short URLs from long links
- Optional custom aliases
- Optional expiration timestamps
- Redirect short links to their destination
- Real-time analytics with Server-Sent Events
- Top-links dashboard
- Local persistence in `data/links.json`
- Delete links from the dashboard

## Run

```bash
node server.js
```

Open `http://127.0.0.1:3000`.

## API

- `GET /api/health`
- `GET /api/links`
- `POST /api/links`
- `DELETE /api/links/:code`
- `GET /api/stats/stream`

## Notes

- Storage is local JSON, so this project runs without any external database.
- `BASE_URL`, `HOST`, and `PORT` can be configured through environment variables.
