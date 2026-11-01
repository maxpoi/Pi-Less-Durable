const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CONTROL_PREFIXES = new Set(["!", "do", "if", "then"]);
const ENV_OPTIONS_WITH_VALUE = new Set(["-C", "--chdir", "-S", "--split-string", "-u", "--unset"]);
const SUDO_OPTIONS_WITH_VALUE = new Set([
	"-C", "--chdir", "-D", "--chroot", "-g", "--group", "-h", "--host",
	"-p", "--prompt", "-R", "--close-from", "-T", "--command-timeout", "-u", "--user",
]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
	"-C",
	"-c",
	"--config-env",
	"--git-dir",
	"--namespace",
	"--super-prefix",
	"--work-tree",
]);

export interface ParsedGitInvocation {
	readonly words: readonly string[];
	readonly executableIndex: number;
	readonly globalArgs: readonly string[];
	readonly subcommand?: string;
	readonly args: readonly string[];
	readonly usesWorkTreeOption: boolean;
}

/** Split ordinary shell input into commands and unquoted words without executing it. */
export function parseShellCommands(input: string): readonly (readonly string[])[] {
	const commands: string[][] = [];
	let words: string[] = [];
	let word = "";
	let wordStarted = false;
	let quote: "'" | '"' | undefined;
	let escaped = false;

	const finishWord = () => {
		if (!wordStarted) return;
		words.push(word);
		word = "";
		wordStarted = false;
	};
	const finishCommand = () => {
		finishWord();
		if (words.length > 0) commands.push(words);
		words = [];
	};

	for (const character of input) {
		if (escaped) {
			word += character;
			wordStarted = true;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			wordStarted = true;
			continue;
		}
		if (quote !== undefined) {
			if (character === quote) quote = undefined;
			else word += character;
			wordStarted = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			wordStarted = true;
			continue;
		}
		if (character === "\n" || character === ";" || character === "|" || character === "&") {
			finishCommand();
			continue;
		}
		if (/\s/.test(character)) {
			finishWord();
			continue;
		}
		word += character;
		wordStarted = true;
	}
	if (escaped) word += "\\";
	finishCommand();
	return commands;
}

function executableName(word: string): string {
	return word.replaceAll("\\", "/").split("/").at(-1) ?? word;
}

function optionName(word: string): string {
	return word.split("=", 1)[0] ?? word;
}

function skipOptions(
	words: readonly string[],
	start: number,
	optionsWithValue: ReadonlySet<string>,
): number {
	let index = start;
	while (index < words.length) {
		const option = words[index];
		if (option === undefined || !option.startsWith("-")) break;
		index++;
		if (!option.includes("=") && optionsWithValue.has(optionName(option))) index++;
	}
	return index;
}

/** Locate an executable after common shell wrappers and leading assignments. */
export function findCommandExecutable(
	words: readonly string[],
	name: string,
): number | undefined {
	let index = 0;
	while (CONTROL_PREFIXES.has(words[index] ?? "")) index++;

	for (;;) {
		while (ASSIGNMENT_PATTERN.test(words[index] ?? "")) index++;
		const wrapper = words[index];
		if (wrapper === "command") {
			index = skipOptions(words, index + 1, new Set());
			continue;
		}
		if (wrapper === "env") {
			index = skipOptions(words, index + 1, ENV_OPTIONS_WITH_VALUE);
			while (ASSIGNMENT_PATTERN.test(words[index] ?? "")) index++;
			continue;
		}
		if (wrapper === "sudo") {
			index = skipOptions(words, index + 1, SUDO_OPTIONS_WITH_VALUE);
			continue;
		}
		break;
	}

	return executableName(words[index] ?? "") === name ? index : undefined;
}

/** Parse one tokenized command when its executable is Git. */
export function parseGitInvocation(
	words: readonly string[],
): ParsedGitInvocation | undefined {
	const executableIndex = findCommandExecutable(words, "git");
	if (executableIndex === undefined) return undefined;

	const globalArgs: string[] = [];
	let usesWorkTreeOption = false;
	let index = executableIndex + 1;
	while (index < words.length) {
		const argument = words[index];
		if (argument === undefined) break;
		if (argument === "--") {
			index++;
			break;
		}
		if (!argument.startsWith("-")) break;

		globalArgs.push(argument);
		const name = optionName(argument);
		if (name === "--work-tree") usesWorkTreeOption = true;
		index++;
		if (!argument.includes("=") && GIT_GLOBAL_OPTIONS_WITH_VALUE.has(name)) {
			const value = words[index];
			if (value !== undefined) globalArgs.push(value);
			index++;
		}
	}

	const subcommand = words[index]?.toLowerCase();
	return {
		words,
		executableIndex,
		globalArgs,
		...(subcommand === undefined ? {} : { subcommand }),
		args: subcommand === undefined ? [] : words.slice(index + 1),
		usesWorkTreeOption,
	};
}

export function findGitInvocations(command: string): readonly ParsedGitInvocation[] {
	return parseShellCommands(command).flatMap(words => {
		const invocation = parseGitInvocation(words);
		return invocation === undefined ? [] : [invocation];
	});
}
