import { fromPromise } from 'xstate';

export const fromTerminal = fromPromise<string, string>(async ({ input }) => {
  const topic = await new Promise<string>((res) => {
    console.log(input + '\n');
    const listener = (data: Buffer) => {
      const result = data.toString().trim();
      process.stdin.off('data', listener);
      res(result);
    };
    process.stdin.on('data', listener);
  });

  return topic;
});

export async function getFromTerminal(msg: string) {
  const topic = await new Promise<string>((res) => {
    console.log(msg + '\n');
    const listener = (data: Buffer) => {
      const result = data.toString().trim();
      process.stdin.off('data', listener);
      res(result);
    };
    process.stdin.on('data', listener);
  });

  return topic;
}
