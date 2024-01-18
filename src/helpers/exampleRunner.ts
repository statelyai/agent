import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

const exampleParams = process.argv.slice(2);
if (exampleParams.length === 0) {
  console.error('No example specified, you can choose from:');
  const exampleFiles = fs.readdirSync('./examples');
  exampleFiles.forEach((file) => {
    const exampleName = file.split('.')[0];
    console.error(`- ${exampleName}`);
  });
  process.exit();
}
const exampleName = exampleParams[0];
require(`../../examples/${exampleName}.ts`);
