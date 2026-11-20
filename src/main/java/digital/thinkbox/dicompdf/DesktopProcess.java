package digital.thinkbox.dicompdf;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

/** Isolated CLI process: expensive work cannot block the Swing event thread. */
final class DesktopProcess {
    private volatile Process process;
    private volatile boolean stopped;
    static List<String> javaCommand(List<String> arguments){return javaCommand(Main.class.getName(),arguments);}
    static List<String> javaCommand(String main,List<String> arguments){
        String binary=System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win")?"java.exe":"java";
        var result=new ArrayList<>(List.of(Path.of(System.getProperty("java.home"),"bin",binary).toString(),
                "-Dfile.encoding=UTF-8","-cp",System.getProperty("java.class.path"),main));
        result.addAll(arguments);return List.copyOf(result);
    }
    boolean stopped(){return stopped;}
    int execute(List<String> command,Consumer<String> display)throws Exception{
        return execute(command,display,null);
    }
    int execute(List<String> command,Consumer<String> display,char[] password)throws Exception{
        if(stopped){if(password!=null)Arrays.fill(password,'\0');return 130;}
        Process child;
        try{child=new ProcessBuilder(command).redirectErrorStream(true).start();}
        catch(Exception failure){if(password!=null)Arrays.fill(password,'\0');throw failure;}
        process=child;
        try(var reader=new InputStreamReader(child.getInputStream(),StandardCharsets.UTF_8)){
            if(stopped)stop();
            try(var input=child.getOutputStream()){if(password!=null)DesktopPassword.write(input,password);}
            char[] block=new char[4096];int count;
            while((count=reader.read(block))!=-1)display.accept(new String(block,0,count));
            return child.waitFor();
        }catch(Exception error){
            terminate();throw error;
        }finally{if(password!=null)Arrays.fill(password,'\0');process=null;}
    }
    void stop(){
        stopped=true;terminate();
    }
    private void terminate(){
        Process child=process;if(child==null)return;
        Thread.ofPlatform().daemon().name("dicom-desktop-stop").start(()->{
            List<ProcessHandle> descendants=child.descendants().toList();
            descendants.forEach(ProcessHandle::destroy);child.destroy();
            try{child.waitFor(2,TimeUnit.SECONDS);}catch(InterruptedException error){Thread.currentThread().interrupt();}
            descendants.stream().filter(ProcessHandle::isAlive).forEach(ProcessHandle::destroyForcibly);
            if(child.isAlive())child.destroyForcibly();
        });
    }
}
