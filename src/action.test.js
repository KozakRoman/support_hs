const axios = require("axios");
const { main } = require("./action");
const { events, incomingTicketEvent } = require("./event-test-data");

// mock the axios call to the openai api because it is expensive
jest.mock("axios", () => jest.requireActual("axios"));
axios.post = jest.fn().mockImplementation((url, postData, options) => {
  // if it is not the openai api call, then just return the regular axios call
  if (url !== "https://api.openai.com/v1/embeddings") {
    return axios({
      method: "post",
      url,
      headers: options.headers,
      data: postData
    });
  }

  const e = events.find(ev => {
    return (
      postData.input ==
      `Ticket name: ${ev.inputFields.subject};\n Ticket description: ${ev.inputFields.content}`
    );
  });
  const data = {
    data: [
      {
        embedding: e.embedding
      }
    ]
  };
  return { data };
});

test("main test", async () => {
  jest.setTimeout(10000);
  await main(incomingTicketEvent, () => {});
});
