# SCORM-LTI Proxy

A Node.js server that hosts SCORM content centrally and provides two integration methods for Learning Management Systems:

1. **LTI 1.1 Integration** - Direct LMS connection with automatic grade passback
2. **SCORM Dispatch** - Thin SCORM packages for LMSs that can't use LTI, with xAPI LRS for results

## Features

- Host SCORM 1.2 and 2004 content on your server
- LTI 1.1 Tool Provider with OAuth signature validation
- Automatic grade passback via LTI Outcomes Service
- Generate thin SCORM dispatch packages for distribution
- xAPI statement generation for dispatch mode
- Multi-tenant support (multiple LMS consumers)
- Admin API for content and consumer management

## Quick Start

### Using Dev Containers (Recommended)

1. Open the project in VS Code
2. Install the "Dev Containers" extension
3. Press `F1` → **Dev Containers: Reopen in Container**
4. Wait for the container to build (includes Node.js 20 + PostgreSQL 16)
5. The server starts automatically on http://localhost:3000

### Manual Setup

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Start PostgreSQL (or update DATABASE_URL in .env)
# Then start the dev server
npm run dev
```

### Production with Docker

```bash
# Set environment variables
export POSTGRES_PASSWORD=secure-password
export SESSION_SECRET=your-secret-key
export BASE_URL=https://your-domain.com

# Start services
docker-compose up -d
```

## API Endpoints

### LTI Integration

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/lti/launch` | POST | LTI 1.1 launch endpoint (OAuth signed) |
| `/lti/config` | GET | LTI tool configuration info |

### SCORM Dispatch

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/dispatch/launch/:token` | GET | Launch content via dispatch token |
| `/dispatch/package/:courseId` | GET | Get dispatch package info |

### Admin API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/admin/consumers` | GET | List all consumers |
| `/admin/consumers` | POST | Create new consumer (returns LTI credentials) |
| `/admin/consumers/:id` | GET | Get consumer details with credentials |
| `/admin/courses` | GET | List all courses |
| `/admin/courses` | POST | Upload SCORM package (multipart/form-data) |
| `/admin/courses/:id` | GET | Get course details |
| `/admin/courses/:id` | DELETE | Soft-delete course |
| `/admin/dispatch/download/:courseId` | GET | Download dispatch package |
| `/admin/stats` | GET | Get usage statistics |
| `/admin/launches` | GET | List recent launches |

### SCORM Runtime API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/scorm/course/:courseId` | GET | Get course metadata |
| `/api/scorm/attempt/:attemptId` | GET | Get attempt data (for resume) |
| `/api/scorm/attempt/:attemptId/commit` | POST | Save CMI data |
| `/api/scorm/attempt/:attemptId/finish` | POST | Mark attempt complete |

## Usage Guide

### 1. Create a Consumer (Customer)

```bash
curl -X POST http://localhost:3000/admin/consumers \
  -H "Content-Type: application/json" \
  -d '{"name": "Acme University"}'
```

Response:
```json
{
  "id": "uuid",
  "name": "Acme University",
  "lti_consumer_key": "key_abc123...",
  "lti_consumer_secret": "secret...",
  "lti_launch_url": "http://localhost:3000/lti/launch"
}
```

### 2. Upload a SCORM Course

```bash
curl -X POST http://localhost:3000/admin/courses \
  -F "package=@my-course.zip" \
  -F "title=Introduction to Safety"
```

### 3. Configure LTI in Customer's LMS

Provide the customer with:
- **Launch URL**: `https://your-server.com/lti/launch`
- **Consumer Key**: From step 1
- **Consumer Secret**: From step 1
- **Custom Parameter**: `course_id=<uuid from step 2>`

### 4. Alternative: Generate Dispatch Package

For customers who can't use LTI:

```bash
curl "http://localhost:3000/admin/dispatch/download/{courseId}?consumerId={consumerId}" \
  --output course-dispatch.zip
```

The customer uploads this thin package to their LMS. When launched, it redirects to your hosted content.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Customer's LMS                              │
│                                                                  │
│  ┌─────────────────┐              ┌─────────────────────────┐   │
│  │ LTI Consumer    │              │ Thin Dispatch Package   │   │
│  │ (direct launch) │              │ (redirects to server)   │   │
│  └────────┬────────┘              └────────────┬────────────┘   │
└───────────┼────────────────────────────────────┼────────────────┘
            │                                    │
            │ LTI Launch                         │ Redirect
            │ + Grade Passback                   │ + xAPI to LRS
            ▼                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SCORM-LTI Proxy Server                        │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ LTI Handler  │  │ SCORM Player │  │ Grade/xAPI Passback    │ │
│  └──────────────┘  └──────────────┘  └────────────────────────┘ │
│                           │                                      │
│                    ┌──────▼──────┐                               │
│                    │ SCORM       │                               │
│                    │ Content     │                               │
│                    └─────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `NODE_ENV` | Environment | development |
| `BASE_URL` | Public URL of the server | http://localhost:3000 |
| `DATABASE_URL` | PostgreSQL connection string | - |
| `SESSION_SECRET` | Secret for session signing | - |
| `CONTENT_DIR` | Directory for SCORM content | ./content |
| `XAPI_LRS_ENDPOINT` | Default xAPI LRS endpoint | - |
| `XAPI_LRS_KEY` | Default LRS auth key | - |
| `XAPI_LRS_SECRET` | Default LRS auth secret | - |

## LTI 1.1 Deprecation Notice

LTI 1.1 is being phased out:
- **June 2026**: Major platforms stop issuing new LTI 1.1 credentials
- **January 2027**: LTI 1.1 support officially ends

The architecture is designed for easy upgrade to LTI 1.3. When ready:
1. Add `ltijs` library
2. Create `/lti/1.3/launch` endpoint
3. Update grade passback to use Assignment and Grade Services (AGS)

## Development

```bash
# Run in development mode (auto-reload)
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run tests
npm test
```

## Database Schema

The application auto-creates these tables on startup:

- `consumers` - LTI consumers (customers/tenants)
- `courses` - SCORM content packages
- `launches` - LTI launch records with outcome URLs
- `attempts` - Learner attempts with CMI data
- `dispatch_tokens` - Tokens for dispatch package authentication

## License

MIT
