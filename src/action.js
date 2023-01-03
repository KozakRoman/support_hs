const hubspot = require("@hubspot/api-client");
const axios = require("axios");

// create a HubSpot api client to make api calls
const hubspotClient = new hubspot.Client({
  accessToken: process.env.HUBSPOT_TOKEN
});

exports.main = async (event, callback) => {
  // extract the ticket name, description, ticket owner id and ticket id from the event object
  const { subject, content, hubspot_owner_id, hs_ticket_id } =
    event.inputFields;

  // extract the portal id from the event object. We need the portal id to construct the url for similar ticket links
  const { portalId } = event.origin;

  // we get the embeddings for the ticket from OpenAI. Embeddings are a way to represent text as a vector(it's just an array of numbers)
  const ticketEmbeddings = await getTicketEmbeddings(subject, content);

  // we get the tickets that are most similar to the new ticket
  const similarTickets = await getSimilarTickets(
    ticketEmbeddings,
    hs_ticket_id
  );

  let newTicketOwner;
  if (!hubspot_owner_id) {
    // if we don't have a ticket owner, we get the new ticket owner by picking the most similar ticket owner
    // here we can add more sophisticated logic to pick other ticket owner
    // for example, we can check if the ticket owner is a free agent and if not, we can pick the next most similar ticket owner
    newTicketOwner = await getNewTicketOwner(similarTickets);
  }

  // we update the ticket with the new embeddings and the new ticket owner
  const updateResp = await updateTicket(hs_ticket_id, {
    embeddings: ticketEmbeddings,
    hubspot_owner_id: newTicketOwner,
    similarTicketsStr: getSimilarityStr(similarTickets, portalId)
  });

  callback({
    outputFields: {}
  });
};

// Functions used in the main function //

function getSimilarityStr(similarTickets, portalId) {
  let str = "<ul>";
  if (similarTickets.length > 3) {
    similarTickets = similarTickets.slice(0, 3);
  }
  similarTickets.forEach(ticket => {
    str += `<li><a href="https://app.hubspot.com/contacts/${portalId}/ticket/${
      ticket.ticketId
    }" target="_blank">${
      ticket.ticketName
    }</a> - Similarity score: ${ticket.similarity.toFixed(2)}</li>\n`;
  });
  str += "</ul>";

  return str;
}

async function getTicketEmbeddings(subject, content) {
  // we create a string that contains the ticket name and description and we get the embeddings for the string
  const ticketString = `Ticket name: ${subject};\n Ticket description: ${content}`;
  const ticketEmbeddings = await getAIEmbedding(ticketString);
  return ticketEmbeddings;
}

async function getAIEmbedding(text) {
  const url = "https://api.openai.com/v1/embeddings";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.OPENAI_TOKEN}`
  };
  const data = { input: text, model: "text-embedding-ada-002" };
  try {
    const resp = await axios.post(url, data, { headers });
    return resp.data.data[0].embedding;
  } catch (err) {
    console.error(err);
    throw err;
  }
}

async function getSimilarTickets(embeddings, excludeTicketId) {
  // we get the tickets that have similarity score with the new ticket
  const ticketsWithSimilarity = await getTicketsWithSimilarity(
    embeddings,
    excludeTicketId
  );

  // sort the tickets by similarity. The most similar ticket will be at the first index
  return ticketsWithSimilarity.sort((a, b) => b.similarity - a.similarity);
}

async function getNewTicketOwner(ticketsWithSimilarity) {
  // sort the tickets by similarity. The most similar ticket will be at the first index
  const sorted = ticketsWithSimilarity.sort(
    (a, b) => b.similarity - a.similarity
  );

  // we get the ticket owner ids from the sorted tickets
  const ticketOwnerIds = sorted.map(ticket => ticket.ticketOwnerId);

  // we remove duplicates from the ticket owner ids
  const ticketOwnersSet = new Set(ticketOwnerIds);
  const ticketOwnerCandidates = [...ticketOwnersSet];

  // we return the ticket owner id
  return ticketOwnerCandidates[0];
}

async function updateTicket(
  ticketId,
  { embeddings, hubspot_owner_id, similarTicketsStr }
) {
  const properties = {};

  if (Array.isArray(embeddings)) {
    properties.ticket_ai_embeddings = JSON.stringify(embeddings);
  }

  if (hubspot_owner_id) {
    properties.hubspot_owner_id = hubspot_owner_id;
  }

  if (similarTicketsStr) {
    properties.similar_tickets = similarTicketsStr;
  }

  try {
    const apiResponse = await hubspotClient.crm.tickets.basicApi.update(
      ticketId,
      { properties },
      undefined
    );
    return apiResponse;
  } catch (e) {
    e.message === "HTTP request failed"
      ? console.error(JSON.stringify(e.response, null, 2))
      : console.error(e);
  }
}

async function searchTicketsWithEmbeddings(excludeTicketId) {
  const data = {
    limit: 100,
    properties: [
      "subject",
      "content",
      "hs_object_id",
      "hubspot_owner_id",
      "ticket_ai_embeddings"
    ],
    filterGroups: [
      {
        filters: [
          {
            propertyName: "ticket_ai_embeddings",
            operator: "HAS_PROPERTY"
          },
          {
            propertyName: "hubspot_owner_id",
            operator: "HAS_PROPERTY"
          }
        ]
      }
    ]
  };

  if (excludeTicketId) {
    data.filterGroups[0].filters.push({
      propertyName: "hs_object_id",
      operator: "NEQ",
      value: excludeTicketId
    });
  }

  try {
    const apiResponse = await hubspotClient.crm.tickets.searchApi.doSearch(
      data
    );
    return apiResponse.body.results || apiResponse.results;
  } catch (e) {
    e.message === "HTTP request failed"
      ? console.error(JSON.stringify(e.response, null, 2))
      : console.error(e);
  }
}

async function getTicketsWithSimilarity(embeddings, excludeTicketId) {
  const searchResults = await searchTicketsWithEmbeddings(excludeTicketId);

  const similarTickets = searchResults.map(ticket => {
    const ticketEmbeddings = JSON.parse(ticket.properties.ticket_ai_embeddings);
    const similarity = cosineSimilarity(embeddings, ticketEmbeddings);
    return {
      ticketId: ticket.properties.hs_object_id,
      ticketOwnerId: ticket.properties.hubspot_owner_id,
      ticketName: ticket.properties.subject,
      similarity
    };
  });

  return similarTickets;
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    console.log(a.length, b.length);
    console.log(a, b);
    throw new Error("Vectors must be of the same length");
  }

  const dotProduct = dot(a, b);
  const magnitudeA = magnitude(a);
  const magnitudeB = magnitude(b);
  return dotProduct / (magnitudeA * magnitudeB);
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

function magnitude(a) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * a[i];
  }
  return Math.sqrt(sum);
}
