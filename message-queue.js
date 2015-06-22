
var Message = function (data, queue) {
    this.Data = data;

    this.Remove = function () {
        //queue.remove(this);
    }
}

var Queue = function () {
    this.Messages = [];

    this.AddMessage = function (message) {
        this.Messages.push(new Message(message, this));
    };

    this.GetMessage = function (message) {
        return this.Messages.pop();
    };

    this.GetLength = function () {
        this.Messages.length;
    };
}

module.exports = Queue;