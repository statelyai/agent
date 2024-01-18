const funnyPhrases = [
  'Concocting chuckles...',
  'Brewing belly laughs...',
  'Fabricating funnies...',
  'Assembling amusement...',
  'Molding merriment...',
  'Whipping up wisecracks...',
  'Generating guffaws...',
  'Inventing hilarity...',
  'Cultivating chortles...',
  'Hatching howlers...',
];
export function getRandomFunnyPhrase() {
  return funnyPhrases[Math.floor(Math.random() * funnyPhrases.length)];
}

const ratingPhrases = [
  'Assessing amusement...',
  'Evaluating hilarity...',
  'Ranking chuckles...',
  'Classifying cackles...',
  'Scoring snickers...',
  'Rating roars...',
  'Judging jollity...',
  'Measuring merriment...',
  'Rating rib-ticklers...',
  'Scaling sniggers...',
];
export function getRandomRatingPhrase() {
  return ratingPhrases[Math.floor(Math.random() * ratingPhrases.length)];
}
