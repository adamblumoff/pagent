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
    sourceToken: process.env.PAGENT_SOURCE_TOKEN,
    endpointUrl: process.env.PAGENT_ENDPOINT_URL,
  }),
);
