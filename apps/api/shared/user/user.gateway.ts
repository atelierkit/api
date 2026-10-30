// 外部依赖
import { SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';

@WebSocketGateway()
export class UserGateway {
  @SubscribeMessage('message')
  handleMessage(client: any, payload: any): string {
    void client;
    void payload;
    return 'Hello world!';
  }
}
