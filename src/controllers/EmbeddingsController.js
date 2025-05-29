// const pipeline = require('@xenova/transformers').pipeline;

function embeddingsControllerFactory(socketService = null) {

  const generateEmbeddings = (req, res) => {
    return res.status(200).json({message: 'generateEmbeddings'});

    // const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    // const output = await extractor(text, { pooling: 'mean', normalize: true });

    // return res.status(200).json(output.data);
  }

  // const main = async (req, res) => {
  //   const sentences = [
  //     "The weather is lovely today.",
  //     "It's so sunny outside!",
  //     "He drove to the stadium."
  //   ];
  
  //   for (const sentence of sentences) {
  //     const embedding = await generateEmbeddings(sentence);
  //     console.log(`Embedding for "${sentence}":`, embedding);
  //   }
  // }

  return {
    generateEmbeddings
  };
}

module.exports = embeddingsControllerFactory; 