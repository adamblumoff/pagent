import {
  createFixtureService,
  pagentOptions,
} from "../../shared/service";

export const service = createFixtureService(
  "next",
  pagentOptions({
    enabled: process.env.PAGENT_ENABLED,
    environment: process.env.PAGENT_ENV,
    encryptionKey: process.env.PAGENT_ENCRYPTION_KEY,
    encryptionKeyId: process.env.PAGENT_ENCRYPTION_KEY_ID,
    relayToken: process.env.PAGENT_RELAY_TOKEN,
    relayUrl: process.env.PAGENT_RELAY_URL,
  }),
);
