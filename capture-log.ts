import kleur from "kleur";
import path from "node:path";

export const captureLog = {
	info: (message: string) => console.log(kleur.blue(message)),
	warn: (message: string) => console.warn(kleur.yellow(message)),
	error: (...messages: unknown[]) => console.error(...messages.map((message) => kleur.red(String(message)))),
	message: (...messages: unknown[]) => console.log(...messages.map((message) => kleur.gray(String(message)))),
	debug: (...messages: unknown[]) => console.log(...messages.map((message) => kleur.dim().gray(String(message)))),
	path: (label: string, value: string) => console.log(`${kleur.bold(label)} ${kleur.blue(path.resolve(value))}`),
};
