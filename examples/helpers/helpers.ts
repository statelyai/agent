import { fromPromise } from 'xstate';

export const getFromTerminal = fromPromise<string, string>(
  async ({ input }) => {
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
  }
);
