// 以 `with { type: 'file' }` 导入的协议资产：值是运行时可读的路径（单文件可执行里是 $bunfs 路径）。
declare module '*.binpb' {
  const path: string;
  export default path;
}
