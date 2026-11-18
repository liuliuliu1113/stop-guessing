import { handleApp } from "./handler.ts";

Deno.serve((request) => handleApp(request));
