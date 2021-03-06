const AWS = require('aws-sdk')
const Message = require('../../messages/message')

module.exports = class SqsBroker {
  constructor(opts = {}) {
    this.opts = this._validate(opts)
    this.sqs = new AWS.SQS({
      apiVersion: '2012-11-05',
      region: opts.aws && opts.aws.region
    })
  }

  // eslint-disable-next-line class-methods-use-this
  _validate(opts) {
    if (opts.validate === false) return opts

    const errors = []

    if (!opts.aws) errors.push('worker need aws configs')
    else if (!opts.aws.region) errors.push('worker need aws region')

    if (!opts.name) errors.push('worker need a name to groupId sqs')

    if (!opts.queue) errors.push('worker need a queue target')

    if (errors.length > 0) throw new Error(errors.join(', '))

    return opts
  }

  publish(message, executionId, tryCount) {
    return this._getQueueUrl().then(QueueUrl => {
      const params = {
        MessageBody: JSON.stringify(message),
        QueueUrl,
        DelaySeconds: 0,
        MessageAttributes: {
          executionId: {
            DataType: 'String',
            StringValue: executionId
          },
          try_count: {
            DataType: 'String',
            StringValue: tryCount.toString()
          }
        },
        MessageGroupId: this.opts.name,
        MessageDeduplicationId: [executionId, tryCount].join(':')
      }

      return this.sqs.sendMessage(params).promise()
    })
  }

  _getQueueUrl() {
    if (this.queueUrl) return Promise.resolve(this.queueUrl)

    const { opts } = this
    return this.sqs
      .getQueueUrl({ QueueName: opts.queue })
      .promise()
      .then(res => res.QueueUrl)
  }

  requeue(msg) {
    this._getQueueUrl().then(() => {
      this.publish(msg.parsedContent(), msg.messageId(), msg.nextTryCount())
    })
  }

  remove(msg) {
    this._getQueueUrl().then(QueueUrl =>
      this.sqs
        .deleteMessage({
          QueueUrl,
          ReceiptHandle: msg.getOriginal().ReceiptHandle
        })
        .promise()
    )
  }

  consume(callback) {
    const { prefetch } = this.opts
    this._getQueueUrl().then(QueueUrl => {
      if (this._consumeLoop) {
        throw new Error(
          `Worker is already consuming queue from URL ${QueueUrl}`
        )
      }

      const params = {
        QueueUrl,
        AttributeNames: ['All'],
        MessageAttributeNames: ['executionId', 'try_count'],
        WaitTimeSeconds: 1,
        MaxNumberOfMessages: prefetch
      }

      this._consumeLoop = setInterval(() => {
        this.sqs
          .receiveMessage(params)
          .promise()
          .then(data => {
            if (data.Messages) {
              const messages = data.Messages.map(
                msg =>
                  new Message(
                    {
                      messageId: msg.MessageAttributes.executionId.StringValue,
                      count: parseInt(
                        msg.MessageAttributes.try_count.StringValue,
                        10
                      ),
                      content: msg.Body
                    },
                    {},
                    msg
                  )
              )

              messages.map(msg => callback(msg))
            }
          })
          .catch(err => console.error(err))
      }, 1000)
    })
  }

  stop() {
    if (this._consumeLoop)
      return Promise.resolve(clearInterval(this._consumerLoop))
    return Promise.resolve(false)
  }
}
