/// <reference types="es6-collections" />
/// <reference types="node" />

import {
	DebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, Event,
	Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import {basename} from 'path';
import {readFileSync, unlink, openSync, closeSync, createReadStream, ReadStream, existsSync, readFile} from 'fs';
import * as ChildProcess from "child_process";

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {

	scriptPath: string;
	commandLineArguments: string;
	bashDbPath: string;
	showDebugOutput?: boolean;
}

class BashDebugSession extends DebugSession {

	private static THREAD_ID = 42;
	private static END_MARKER = "############################################################";

	protected _debuggerProcess: ChildProcess.ChildProcess;

	private _currentBreakpointIds = new Map<string, Array<number>>();

	private _fullDebugOutput = [""];
	private _fullDebugOutputIndex = 0;

	private _debuggerExecutableBusy = false;
	private _debuggerExecutableClosing = false;

	private _responsivityFactor = 5;

	private _fifoPath = "/tmp/vscode-bash-debug.fifo";

	public constructor() {
		super();
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);
	}

	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

		response.body.supportsConditionalBreakpoints = false;
		response.body.supportsConfigurationDoneRequest = false;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsStepBack = false;
		response.body.supportsSetVariable = false;
		this.sendResponse(response);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		this._debuggerExecutableBusy = false;
		var kill = require('tree-kill');

		this._debuggerProcess.on("exit", ()=> {
			this._debuggerExecutableClosing = true;
			this.sendResponse(response)
		});

		kill(this._debuggerProcess.pid, 'SIGTERM', (err)=> this._debuggerProcess.stdin.write(`quit\n`));
	}

	protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {

		if (!args.bashDbPath) {
			args.bashDbPath = "bashdb";
		}

		// use fifo, because --tty '&1' does not work properly for subshell (when bashdb spawns - $() )
		// when this is fixed in bashdb, use &1
		this._debuggerProcess = ChildProcess.spawn("bash", ["-c", `
			mkfifo "${this._fifoPath}"
			trap 'echo "TERMINATED BASHDB SUBPROCESS"' TERM
			trap 'echo "INTERRUPTED BASHDB SUBPROCESS"' INT
			trap 'rm "${this._fifoPath}"; echo "EXITED DEBUGGER PROCESS ($?)"; exit;' EXIT
			${args.bashDbPath} --quiet --tty "${this._fifoPath}" -- "${args.scriptPath}" ${args.commandLineArguments}`
		]);

		this.processDebugTerminalOutput(args.showDebugOutput == true);

		this._debuggerProcess.stdin.write(`print '${BashDebugSession.END_MARKER}'\n`);

		this._debuggerProcess.stdout.on("data", (data) => {
			this.sendEvent(new OutputEvent(`${data}`, 'console'));
		});

		this._debuggerProcess.stderr.on("data", (data) => {
			this.sendEvent(new OutputEvent(`${data}`, 'stderr'));
		});

		this.scheduleExecution(() => this.launchRequestFinalize(response, args));
	}

	private launchRequestFinalize(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {

		for (var i = 0; i < this._fullDebugOutput.length; i++) {
			if (this._fullDebugOutput[i] == BashDebugSession.END_MARKER) {

				this.sendResponse(response);
				this.sendEvent(new InitializedEvent());

				var interval = setInterval((data) => {
					for (; this._fullDebugOutputIndex < this._fullDebugOutput.length - 1; this._fullDebugOutputIndex++)
					{
						var line = this._fullDebugOutput[this._fullDebugOutputIndex];

						if (line.indexOf("(/") == 0 && line.indexOf("):") == line.length-2)
						{
							this.sendEvent(new StoppedEvent("break", BashDebugSession.THREAD_ID));
						}
						else if (line.indexOf("terminated") > 0)
						{
							clearInterval(interval);
							this.sendEvent(new TerminatedEvent());
						}
					}
				},
				this._responsivityFactor);
				return;
			}
		}

		this.scheduleExecution(()=>this.launchRequestFinalize(response, args));
	}


	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

		if (this._debuggerExecutableBusy)
		{
			this.scheduleExecution(()=>	this.setBreakPointsRequest(response, args));
			return;
		}

		if (!this._currentBreakpointIds[args.source.path]){
			this._currentBreakpointIds[args.source.path] = [];
		}

		var setBreakpointsCommand = `print 'delete <${this._currentBreakpointIds[args.source.path].join(" ")}>'\ndelete ${this._currentBreakpointIds[args.source.path].join(" ")}\nload ${args.source.path}\n`;
		args.breakpoints.forEach((b)=>{ setBreakpointsCommand += `print ' <${args.source.path}:${b.line}> '\nbreak ${args.source.path}:${b.line}\n` });

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this._debuggerProcess.stdin.write(`${setBreakpointsCommand}print '${BashDebugSession.END_MARKER}'\n`);
		this.scheduleExecution(()=>	this.setBreakPointsRequestFinalize(response, args, currentLine));
	}

	private setBreakPointsRequestFinalize(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, currentOutputLength:number): void {
		this.sendResponse(response);

		if (this.promptReached(currentOutputLength))
		{
			this._currentBreakpointIds[args.source.path] = [];
			var breakpoints = new Array<Breakpoint>();

			for (var i = currentOutputLength; i < this._fullDebugOutput.length - 2; i++ ){

				if (this._fullDebugOutput[i-1].indexOf(" <") == 0 && this._fullDebugOutput[i-1].indexOf("> ") > 0) {

					var lineNodes = this._fullDebugOutput[i].split(" ");
					const bp = <DebugProtocol.Breakpoint> new Breakpoint(true, this.convertDebuggerLineToClient(parseInt(lineNodes[lineNodes.length-1].replace(".",""))));
					bp.id = parseInt(lineNodes[1]);
					breakpoints.push(bp);
					this._currentBreakpointIds[args.source.path].push(bp.id);
				}
			}

			response.body = { breakpoints: breakpoints };
			this._debuggerExecutableBusy = false;
			this.sendResponse(response);
			return;
		}

		this.scheduleExecution(()=> this.setBreakPointsRequestFinalize(response, args, currentOutputLength));
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		response.body = { threads: [ new Thread(BashDebugSession.THREAD_ID, "Bash thread") ]};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

		if (this._debuggerExecutableBusy)
		{
			this.scheduleExecution(()=>	this.stackTraceRequest(response, args));
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this._debuggerProcess.stdin.write(`print backtrace\nbacktrace\nprint '${BashDebugSession.END_MARKER}'\n`);
		this.scheduleExecution(() => this.stackTraceRequestFinalize(response, args, currentLine));
	}

	private stackTraceRequestFinalize(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, currentOutputLength:number): void {

		if (this.promptReached(currentOutputLength))
		{
			var lastStackLineIndex = this._fullDebugOutput.length - 3;

			const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
			const maxLevels = typeof args.levels === 'number' ? args.levels : 100;

			const frames = new Array<StackFrame>();
			for (var i= currentOutputLength; i <= lastStackLineIndex ; i++) {
				var lineContent = this._fullDebugOutput[i];
				var frameIndex = parseInt(lineContent.substr(2, 2));
				var frameText = lineContent;
				var frameSourcePath = lineContent.substr(lineContent.lastIndexOf("`") + 1, lineContent.lastIndexOf("'") - lineContent.lastIndexOf("`") - 1);
				var frameLine = parseInt(lineContent.substr(lineContent.lastIndexOf(" ")));

				frames.push(new StackFrame(
					frameIndex,
					frameText,
					new Source(basename(frameSourcePath), this.convertDebuggerPathToClient(frameSourcePath)),
					this.convertDebuggerLineToClient(frameLine)
					));
			}

			var totalFrames = this._fullDebugOutput.length - currentOutputLength -1;

			response.body = { stackFrames: frames, totalFrames: totalFrames };
			this._debuggerExecutableBusy = false;
			this.sendResponse(response);
			return;
		}

		this.scheduleExecution(() => this.stackTraceRequestFinalize(response, args, currentOutputLength));
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		var scopes = [ new Scope("Local", this._fullDebugOutputIndex, false) ];
		response.body = { scopes: scopes };
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {

		if (this._debuggerExecutableBusy)
		{
			this.scheduleExecution(()=>	this.variablesRequest(response, args));
			return;
		}

		var getVariablesCommand = `info program\n`;
		["PWD","?","0","1","2","3","4","5","6","7","8","9"].forEach((v)=>{ getVariablesCommand += `print ' <$${v}> '\nexamine $${v}\n` });

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this._debuggerProcess.stdin.write(`${getVariablesCommand}print '${BashDebugSession.END_MARKER}'\n`);
		this.scheduleExecution(()=> this.variablesRequestFinalize(response, args, currentLine));
	}

	private variablesRequestFinalize(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, currentOutputLength:number): void {

		if (this.promptReached(currentOutputLength))
		{
			var variables = [];

			for (var i = currentOutputLength; i < this._fullDebugOutput.length - 2; i++ ){

				if (this._fullDebugOutput[i-1].indexOf(" <") == 0 && this._fullDebugOutput[i-1].indexOf("> ") > 0) {

					var lineNodes = this._fullDebugOutput[i].split(" ");
					variables.push({
						name: `${this._fullDebugOutput[i-1].replace(" <", "").replace("> ", "")}`,
						type: "string",
						value: this._fullDebugOutput[i],
						variablesReference: 0
					});
				}
			}

			response.body = { variables: variables };
			this._debuggerExecutableBusy = false;
			this.sendResponse(response);
			return;
		}

		this.scheduleExecution(()=> this.variablesRequestFinalize(response, args, currentOutputLength));
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {

		if (this._debuggerExecutableBusy)
		{
			this.scheduleExecution(()=>	this.continueRequest(response, args));
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this._debuggerProcess.stdin.write(`print continue\ncontinue\nprint '${BashDebugSession.END_MARKER}'\n`);

		this.scheduleExecution(()=>this.continueRequestFinalize(response, args, currentLine));

		// NOTE: do not wait for step to finish
		this.sendResponse(response);
	}

	private continueRequestFinalize(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, currentOutputLength:number): void {

		if (this.promptReached(currentOutputLength))
		{
			this._debuggerExecutableBusy = false;
			return;
		}

		this.scheduleExecution(()=>this.continueRequestFinalize(response, args, currentOutputLength));
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {

		if (this._debuggerExecutableBusy)
		{
			this.scheduleExecution(()=>	this.nextRequest(response, args));
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this._debuggerProcess.stdin.write(`print next\nnext\nprint '${BashDebugSession.END_MARKER}'\n`);

		this.scheduleExecution(()=>this.nextRequestFinalize(response, args, currentLine));

		// NOTE: do not wait for step to finish
		this.sendResponse(response);
	}

	private nextRequestFinalize(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, currentOutputLength:number): void {

		if (this.promptReached(currentOutputLength))
		{
			this._debuggerExecutableBusy = false;
			return;
		}

		this.scheduleExecution(()=>this.nextRequestFinalize(response, args, currentOutputLength));
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {

		if (this._debuggerExecutableBusy)
		{
			this.scheduleExecution(()=>	this.stepInRequest(response, args));
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this._debuggerProcess.stdin.write(`print step\nstep\nprint '${BashDebugSession.END_MARKER}'\n`);

		this.scheduleExecution(()=>this.stepInRequestFinalize(response, args, currentLine));

		// NOTE: do not wait for step to finish
		this.sendResponse(response);
	}

	private stepInRequestFinalize(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, currentOutputLength:number): void {
		if (this.promptReached(currentOutputLength))
		{
			this._debuggerExecutableBusy = false;
			return;
		}

		this.scheduleExecution(()=>this.stepInRequestFinalize(response, args, currentOutputLength));
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {

		if (this._debuggerExecutableBusy)
		{
			this.scheduleExecution(()=>	this.stepOutRequest(response, args));
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this._debuggerProcess.stdin.write(`print finish\nfinish\nprint '${BashDebugSession.END_MARKER}'\n`);

		this.scheduleExecution(()=>this.stepOutRequestFinalize(response, args, currentLine));

		// NOTE: do not wait for step to finish
		this.sendResponse(response);
	}

	private stepOutRequestFinalize(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, currentOutputLength:number): void {
		if (this.promptReached(currentOutputLength))
		{
			this._debuggerExecutableBusy = false;
			return;
		}

		this.scheduleExecution(()=>this.stepOutRequestFinalize(response, args, currentOutputLength));
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {

		if (this._debuggerExecutableBusy)
		{
			this.scheduleExecution(()=>	this.evaluateRequest(response, args));
			return;
		}

		this._debuggerExecutableBusy = true;
		var currentLine = this._fullDebugOutput.length;
		this._debuggerProcess.stdin.write(`print 'examine <${args.expression}>'\nexamine ${args.expression.replace("\"", "")}\nprint '${BashDebugSession.END_MARKER}'\n`);
		this.scheduleExecution(()=>this.evaluateRequestFinalize(response, args, currentLine));
	}

	private evaluateRequestFinalize(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments, currentOutputLength:number): void {

		if (this.promptReached(currentOutputLength))
		{
			response.body = { result: `${args.expression} = '${this._fullDebugOutput[currentOutputLength]}'`, variablesReference: 0	};

			this._debuggerExecutableBusy = false;
			this.sendResponse(response);
			return;
		}

		this.scheduleExecution(()=>this.evaluateRequestFinalize(response, args, currentOutputLength));
	}

	private removePrompt(line : string): string{
		if (line.indexOf("bashdb<") == 0) {
			return line.substr(line.indexOf("> ") + 2);
		}

		return line;
	}

	private promptReached(currentOutputLength:number) : boolean{
		return this._fullDebugOutput.length > currentOutputLength && this._fullDebugOutput[this._fullDebugOutput.length -2] == BashDebugSession.END_MARKER;
	}

	private processDebugTerminalOutput(sendOutput: boolean): void {
		if (!existsSync(this._fifoPath)) {
			this.scheduleExecution(() => this.processDebugTerminalOutput(sendOutput));
			return;
		}

		var readStream = createReadStream(this._fifoPath, { flags: "r", mode: 0x124 })

		readStream.on('data', (data) => {
			if (sendOutput) {
				this.sendEvent(new OutputEvent(`${data}`));
			}

			var list = data.toString().split("\n", -1);
			var fullLine = `${this._fullDebugOutput.pop()}${list.shift()}`;
			this._fullDebugOutput.push(this.removePrompt(fullLine));
			list.forEach(l => this._fullDebugOutput.push(this.removePrompt(l)));
		})

		readStream.on('end', (data) => {
			this.scheduleExecution(() => this.processDebugTerminalOutput(sendOutput));
		})
	}

	private scheduleExecution(callback: (...args: any[]) => void) : void {
		if (!this._debuggerExecutableClosing) {
			setTimeout(() => callback(), this._responsivityFactor);
		}
	}
}

DebugSession.run(BashDebugSession);
