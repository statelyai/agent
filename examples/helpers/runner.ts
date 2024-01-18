import dotenv from 'dotenv';
import { existsSync, readdirSync } from 'fs';
dotenv.config();

function showExamples() {
  const exampleFiles = readdirSync('./examples', { withFileTypes: true });
  exampleFiles.forEach((file) => {
    if (file.isDirectory()) return;
    const exampleName = file.name.split('.')[0];
    console.log(`- ${exampleName}`);
  });
  process.exit();
}

const exampleParams = process.argv.slice(2);
if (exampleParams.length === 0) {
  console.error('No example specified, you can choose from:');
  showExamples();
}
const exampleName = exampleParams[0];
const filePath = `./examples/${exampleName}.ts`;
if (existsSync(filePath)) {
  require(filePath);
} else {
  console.error(`Example ${exampleName} does not exist, you can choose from:`);
  showExamples();
}
