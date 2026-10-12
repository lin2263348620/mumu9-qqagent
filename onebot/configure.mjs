import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const configDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('NapCat config directory is required.');

const template = JSON.parse(fs.readFileSync(path.join(here, 'onebot11.json'), 'utf8'));
fs.mkdirSync(configDir, { recursive: true });

const accountFiles = fs.readdirSync(configDir)
  .filter((name) => /^onebot11_\d+\.json$/.test(name));
const files = ['onebot11.json', ...accountFiles];

function upsertServer(servers, wanted) {
  const list = Array.isArray(servers) ? servers : [];
  const index = list.findIndex((server) => server?.name === wanted.name || Number(server?.port) === wanted.port);
  if (index < 0) return [...list, wanted];
  list[index] = {
    ...list[index],
    ...wanted,
    token: String(list[index]?.token ?? wanted.token ?? '')
  };
  return list;
}

for (const name of files) {
  const target = path.join(configDir, name);
  let config = {};
  if (fs.existsSync(target)) {
    try {
      config = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid NapCat config ${target}: ${error.message}`);
    }
  }

  config.network = config.network && typeof config.network === 'object' ? config.network : {};
  config.network.httpServers = upsertServer(
    config.network.httpServers,
    template.network.httpServers[0]
  );
  config.network.websocketServers = upsertServer(
    config.network.websocketServers,
    template.network.websocketServers[0]
  );

  for (const key of ['httpSseServers', 'httpClients', 'websocketClients', 'plugins']) {
    if (!Array.isArray(config.network[key])) config.network[key] = [];
  }
  for (const key of ['musicSignUrl', 'enableLocalFile2Url', 'parseMultMsg', 'imageDownloadProxy', 'timeout']) {
    if (config[key] === undefined) config[key] = template[key];
  }

  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

console.log(`NapCat OneBot config ready: ${configDir}`);
