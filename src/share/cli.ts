import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createSnapshotServer } from './transport.ts'

const [directory, keyFile, certFile] = process.argv.slice(2)
const token = process.env.DSH_SHARE_PUBLISH_TOKEN
if (!directory || !keyFile || !certFile || !token) throw new Error('Usage: node share-service.js <data-directory> <key.pem> <cert.pem>; set DSH_SHARE_PUBLISH_TOKEN first')
const port = Number(process.env.DSH_SHARE_PORT ?? '8443')
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid DSH_SHARE_PORT')
const server = await createSnapshotServer({directory:resolve(directory),key:await readFile(keyFile),cert:await readFile(certFile),bearerToken:token})
server.listen(port, process.env.DSH_SHARE_BIND ?? '127.0.0.1', () => process.stdout.write(`Snapshot HTTPS service listening on port ${port}\n`))
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{server.close();server.closeAllConnections()})
