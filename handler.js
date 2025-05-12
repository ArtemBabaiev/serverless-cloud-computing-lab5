'use strict';

const yup = require('yup');
const { v4: uuidv4 } = require('uuid');
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");


const postOrgSchema = yup.object({
  name: yup.string().required('Name is required'),
  description: yup.string().required('Description is required')
});

const postUserSchema = yup.object({
  name: yup.string().required('Name is required'),
  email: yup.string().email('Invalid email').required('Email is required'),
});

const putOrgSchema = yup.object({
  orgId: yup.string().required("Organization Id is required"),
  name: yup.string().trim(),
  description: yup.string().trim()
});

const putUserSchema = yup.object({
  userId: yup.string().required('User ID is required'),
  name: yup.string().required('Name is required')
});

const ORGANIZATIONS_TABLE = 'organizationsTable';
const USERS_TABLE = 'usersTable';

const client = new DynamoDBClient({
  region: 'eu-west-1',
  endpoint: 'http://0.0.0.0:8000',
  credentials: {
    accessKeyId: 'MockAccessKeyId',
    secretAccessKey: 'MockSecretAccessKey'
  },
});

const docClient = DynamoDBDocumentClient.from(client);

module.exports.postOrganization = async (event) => {
  try {
    let body = extractBody(event)
    let organization = validate(body, postOrgSchema);

    const queryResult = await performCommand(QueryCommand, {
      TableName: ORGANIZATIONS_TABLE,
      IndexName: 'name-index',
      KeyConditionExpression: '#n = :name',
      ExpressionAttributeNames: {
        '#n': 'name'
      },
      ExpressionAttributeValues: {
        ':name': organization.name
      }
    });

    if (queryResult.Items.length > 0) {
      throw new RequestException(400, "Organization with this name already exists");
    }

    const orgId = uuidv4();

    let res = await performCommand(PutCommand,
      {
        TableName: ORGANIZATIONS_TABLE,
        Item: {
          orgId: orgId,
          ...organization
        }
      }
    )

    return getResponseObject(200, { orgId: orgId })
  } catch (error) {
    return handleError(error);
  }
};

module.exports.postUser = async (event) => {
  try {
    const orgId = event.pathParameters.orgId;

    let getOrgResult = await performCommand(GetCommand,
      {
        TableName: ORGANIZATIONS_TABLE,
        Key: {
          orgId: orgId
        }
      }
    );

    if (!getOrgResult.Item) {
      throw new RequestException(400, "Organization not found");
    }

    let body = extractBody(event)

    let user = validate(body, postUserSchema);

    const queryResult = await performCommand(QueryCommand, {
      TableName: USERS_TABLE,
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: {
        ':email': user.email
      }
    });

    if (queryResult.Items.length > 0) {
      throw new RequestException(400, "User with this email already exists");
    }

    const userId = uuidv4();

    await performCommand(PutCommand, {
      TableName: USERS_TABLE,
      Item: {
        userId: userId,
        orgId: orgId,
        ...user
      }
    })

    return getResponseObject(200, { userId: userId })
  } catch (error) {
    return handleError(error)
  }
}

module.exports.putOrganization = async (event) => {
  try {
    let body = extractBody(event)
    let organization = validate(body, putOrgSchema);

    const updates = {};
    if (organization.name !== undefined) updates.name = organization.name;
    if (organization.description !== undefined) updates.description = organization.description;

    if (Object.keys(updates).length === 0) {
      throw new RequestException(400, 'At least one of name or description must be provided');
    }

    const existing = await performCommand(GetCommand, {
      TableName: 'organizationsTable',
      Key: { orgId: organization.orgId }
    });

    if (!existing.Item) {
      throw new RequestException(404, 'Organization not found');
    }

    let expression = 'SET ' + Object.keys(updates)
      .map((key, index) => `#${key} = :${key}`)
      .join(', ');
    let attributesNames = {}
    let attributesValues = {}
    Object.keys(updates).forEach((key, index) => {
      attributesNames[`#${key}`] = `${key}`;
      attributesValues[`:${key}`] = updates[`${key}`];
    });

    let params = {
      TableName: ORGANIZATIONS_TABLE,
      Key: {
        orgId: organization.orgId
      },
      UpdateExpression: expression,
      ExpressionAttributeNames: attributesNames,
      ExpressionAttributeValues: attributesValues,
      ReturnValues: 'ALL_NEW'
    }

    let result = await performCommand(UpdateCommand, params)

    return getResponseObject(200, result.Attributes);
  } catch (error) {
    return handleError(error)
  }
}

module.exports.putUser = async (event) => {
  try {
    const orgId = event.pathParameters.orgId;
    const body = extractBody(event);
    const userUpdate = validate(body, putUserSchema);

    const userData = await performCommand(GetCommand, {
      TableName: USERS_TABLE,
      Key: { userId: userUpdate.userId }
    });

    if (!userData.Item) {
      throw new RequestException(404, 'User not found');
    }

    if (userData.Item.orgId !== orgId) {
      throw new RequestException(403, 'User does not belong to the specified organization');
    }

    const result = await performCommand(UpdateCommand, {
      TableName: USERS_TABLE,
      Key: { userId: userUpdate.userId },
      UpdateExpression: 'SET #name = :name',
      ExpressionAttributeNames: {
        '#name': 'name'
      },
      ExpressionAttributeValues: {
        ':name': userUpdate.name
      },
      ReturnValues: 'ALL_NEW'
    });

    return getResponseObject(200, result.Attributes);
  } catch (error) {
    return handleError(error)
  }
}

function getResponseObject(code, body) {
  return {
    statusCode: code,
    body: JSON.stringify(body)
  }
}

function extractBody(event) {
  try {
    return JSON.parse(event.body)
  } catch (error) {
    throw new RequestException(400, "Invalid Json body");
  }
}

function validate(obj, schema) {
  try {
    return schema.validateSync(obj, { abortEarly: false, strict: true })
  } catch (error) {
    throw new RequestException(400, error.errors.join(" "));
  }
}

function handleError(error) {
  if (error instanceof RequestException) {
    return getResponseObject(error.code, {
      message: error.message
    })
  }
  console.log(error);
  return getResponseObject(500, {
    message: error.message
  })
}

function performCommand(CommandClass, params) {
  return docClient.send(new CommandClass(params));
}

class RequestException extends Error {
  constructor(code, message) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}