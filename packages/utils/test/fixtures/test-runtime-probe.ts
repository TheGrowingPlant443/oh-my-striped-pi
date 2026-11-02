import { isBunTestRuntime } from "@oh-my-striped-pi/pi-utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
