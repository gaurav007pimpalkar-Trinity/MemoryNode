import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function requireApiBaseInProd() {
  return {
    name: "require-api-base-prod",
    config(_, { mode }) {
      if (mode === "production") {
        const base = process.env.VITE_API_BASE_URL?.trim();
        const isLocalhost = base && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(base);
        if (!base || isLocalhost) {
          throw new Error(
            "Production build requires VITE_API_BASE_URL to be set and non-localhost. Set it in the environment or .env.production."
          );
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [requireApiBaseInProd(), react()],
  server: {
    port: 4173,
  },
});
